import { Runnable, RunnableConfig } from "@langchain/core/runnables";
import { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { v4 as uuidv4 } from "uuid";
import { createLogger, LogLevel } from "../logger.js";
import { getMessageContentString } from "@openswe/shared/messages";

const logger = createLogger(LogLevel.INFO, "MockModel");

/**
 * Check if mock LLM mode is enabled via environment variable
 */
export function isMockLLMEnabled(): boolean {
  return process.env.OPEN_SWE_MOCK_LLM === "true";
}

/**
 * Global state tracker for mock LLM to track progress across invocations
 */
let mockInvocationCount = 0;

/**
 * Programmer-specific invocation counter (reset when entering programmer phase)
 */
let programmerInvocationCount = 0;
let inProgrammerPhase = false;

/**
 * Context-gathering phase counter (to eventually break out of the context-gathering loop)
 */
let contextGatheringCount = 0;
const MAX_CONTEXT_GATHERING_CALLS = 2; // After 2 calls, stop gathering context

/**
 * Reset the mock state (useful for testing)
 */
export function resetMockState(): void {
  mockInvocationCount = 0;
  programmerInvocationCount = 0;
  inProgrammerPhase = false;
  contextGatheringCount = 0;
}

/**
 * Flask app source code for the mock demo
 */
const FLASK_APP_CODE = `from flask import Flask, render_template, jsonify

app = Flask(__name__)

click_count = 0

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/click', methods=['POST'])
def click():
    global click_count
    click_count += 1
    return jsonify({'count': click_count, 'message': f'Button clicked {click_count} times!'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
`;

const REQUIREMENTS_TXT = `flask==3.0.0
`;

const PREVIEW_JSON = `{
  "name": "Flask Demo App",
  "command": "python3 app.py",
  "port": 5000,
  "install": "pip3 install -r requirements.txt",
  "healthcheck": "/"
}
`;

const START_SH = `#!/bin/bash
set -e

# Use PORT env var if set (from UI), otherwise read from preview.json
if [ -n "$PORT" ]; then
  echo "Using PORT from environment: $PORT"
else
  if [ -f preview.json ]; then
    PORT=$(python3 -c "import json; print(json.load(open('preview.json'))['port'])")
    echo "Using PORT from preview.json: $PORT"
  else
    PORT=5000
    echo "Using default PORT: $PORT"
  fi
fi

# Install dependencies if pip is available
if command -v pip3 &> /dev/null && [ -f requirements.txt ]; then
  echo "Installing dependencies..."
  pip3 install -r requirements.txt 2>/dev/null || echo "pip install skipped"
fi

export PORT
echo "Starting server on port $PORT..."
python3 app.py
`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mock Flask App</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            backdrop-filter: blur(10px);
        }
        h1 {
            margin-bottom: 1rem;
        }
        .btn {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 15px 32px;
            font-size: 18px;
            border-radius: 8px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }
        .btn:active {
            transform: scale(0.98);
        }
        #result {
            margin-top: 1.5rem;
            font-size: 1.2rem;
            min-height: 1.5em;
        }
        .mock-badge {
            position: fixed;
            top: 10px;
            right: 10px;
            background: #ff6b6b;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="mock-badge">MOCK LLM DEMO</div>
    <div class="container">
        <h1>Welcome to the Demo App!</h1>
        <p>This app was created by the Mock LLM for testing purposes.</p>
        <button class="btn" onclick="handleClick()">Click Me!</button>
        <div id="result"></div>
    </div>
    <script>
        async function handleClick() {
            try {
                const response = await fetch('/click', { method: 'POST' });
                const data = await response.json();
                document.getElementById('result').textContent = data.message;
            } catch (error) {
                document.getElementById('result').textContent = 'Click registered! (Demo mode)';
            }
        }
    </script>
</body>
</html>
`;

/**
 * Extract message content from various input types
 */
function extractLastMessageContent(input: BaseLanguageModelInput): string {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input) && input.length > 0) {
    const lastItem = input[input.length - 1];

    if (typeof lastItem === "string") {
      return lastItem;
    }

    if (lastItem && typeof lastItem === "object" && "content" in lastItem) {
      return getMessageContentString((lastItem as BaseMessage).content);
    }
  }

  return "";
}

/**
 * Check if a tool is available in the bound tools
 */
function hasToolByName(tools: BindToolsInput[], name: string): boolean {
  return tools.some(
    (t) => typeof t === "object" && "name" in t && t.name === name,
  );
}

/**
 * Generate tool calls for creating the Flask app
 */
function generateFlaskAppToolCalls(
  boundTools: BindToolsInput[],
): {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
} {
  // Track programmer phase separately from global invocation count
  if (!inProgrammerPhase) {
    inProgrammerPhase = true;
    programmerInvocationCount = 0;
  }
  programmerInvocationCount++;

  const hasShell = hasToolByName(boundTools, "shell");
  const hasMarkComplete = hasToolByName(boundTools, "mark_task_completed");

  logger.info("Generating Flask app tool calls", {
    programmerInvocation: programmerInvocationCount,
    globalInvocation: mockInvocationCount,
    hasShell,
    hasMarkComplete,
    boundToolCount: boundTools.length,
  });

  const invocationCount = programmerInvocationCount;

  // Step 1: Create the Flask app files
  if (invocationCount === 1) {
    if (!hasShell) {
      return {
        content:
          "[MOCK LLM] Shell tool not available. Cannot create Flask app.",
        toolCalls: undefined,
      };
    }

    return {
      content:
        "I'll create a Flask web application with a working button. Let me set up the project structure and files.",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: ["mkdir", "-p", "templates"],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 2: Create app.py
  if (invocationCount === 2) {
    return {
      content: "Creating the main Flask application file (app.py)...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: [
              "bash",
              "-c",
              `cat > app.py << 'MOCKEOF'\n${FLASK_APP_CODE}MOCKEOF`,
            ],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 3: Create requirements.txt
  if (invocationCount === 3) {
    return {
      content: "Creating requirements.txt for dependencies...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: [
              "bash",
              "-c",
              `cat > requirements.txt << 'MOCKEOF'\n${REQUIREMENTS_TXT}MOCKEOF`,
            ],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 4: Create index.html template
  if (invocationCount === 4) {
    return {
      content: "Creating the HTML template with a working button...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: [
              "bash",
              "-c",
              `cat > templates/index.html << 'MOCKEOF'\n${INDEX_HTML}MOCKEOF`,
            ],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 5: Create preview.json
  if (invocationCount === 5) {
    return {
      content: "Creating preview.json with app configuration...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: [
              "bash",
              "-c",
              `cat > preview.json << 'MOCKEOF'\n${PREVIEW_JSON}MOCKEOF`,
            ],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 6: Create start.sh
  if (invocationCount === 6) {
    return {
      content: "Creating start.sh startup script...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: [
              "bash",
              "-c",
              `cat > start.sh << 'MOCKEOF'\n${START_SH}MOCKEOF\nchmod +x start.sh`,
            ],
            timeout: 30,
          },
        },
      ],
    };
  }

  // Step 7: Run start.sh to install deps and start server
  if (invocationCount === 7) {
    return {
      content: "Starting the Flask application...",
      toolCalls: [
        {
          id: uuidv4(),
          name: "shell",
          args: {
            command: ["bash", "start.sh"],
            timeout: 180,
          },
        },
      ],
    };
  }

  // Step 8: Mark task completed
  if (invocationCount >= 8 && hasMarkComplete) {
    return {
      content:
        "The Flask application has been created and started successfully! It includes a webpage with a working button that tracks clicks.",
      toolCalls: [
        {
          id: uuidv4(),
          name: "mark_task_completed",
          args: {
            completed_task_summary:
              "Created a Flask web application with the following components:\n" +
              "1. app.py - Main Flask application with routes for the homepage and click counter\n" +
              "2. requirements.txt - Flask dependency specification\n" +
              "3. templates/index.html - Styled HTML page with a button that tracks clicks via AJAX\n" +
              "4. preview.json - App configuration for preview (port 5000)\n" +
              "5. start.sh - Startup script that reads preview.json and launches the server\n\n" +
              "The app features:\n" +
              "- A modern gradient design with glassmorphism effects\n" +
              "- A 'Click Me!' button that POSTs to /click and displays the count\n" +
              "- Responsive design that works on all screen sizes\n\n" +
              "Server is running on port 5000. Use ./start.sh to restart.",
          },
        },
      ],
    };
  }

  // Fallback - just return completion message
  return {
    content:
      "[MOCK LLM] Flask app creation complete. The dev server should start automatically.",
    toolCalls: undefined,
  };
}

/**
 * Generate plan tool call for the planner phase
 */
function generatePlanToolCalls(): {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
} {
  return {
    content:
      "I'll create a Flask web application with a working button for this demo.",
    toolCalls: [
      {
        id: uuidv4(),
        name: "session_plan",
        args: {
          title: "Create Flask Web App with Interactive Button",
          plan: [
            "Create project structure with templates directory for Flask app",
            "Create **app.py** with Flask routes: homepage route (/) and click counter route (/click) that returns JSON",
            "Create **requirements.txt** with flask==3.0.0 dependency",
            "Create **templates/index.html** with styled button and JavaScript click handler that POSTs to /click endpoint",
            "Install Flask dependencies using pip install -r requirements.txt",
          ],
        },
      },
    ],
  };
}

/**
 * Generate feature graph tool calls for the feature graph agent phase
 */
function generateFeatureGraphToolCalls(): {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
} {
  logger.info("Generating create_feature tool call for mock feature");
  return {
    content: "I'll add this feature to the feature graph for tracking.",
    toolCalls: [
      {
        id: uuidv4(),
        name: "create_feature",
        args: {
          featureId: "flask-demo-app",
          name: "Flask Demo Web Application",
          summary: "A Flask web application with an interactive button that tracks clicks. Features a modern gradient UI with glassmorphism effects and real-time click counter via AJAX.",
        },
      },
    ],
  };
}

/**
 * Generate classification/router tool call
 */
function generateClassificationToolCall(toolName: string): {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, any> }>;
} {
  return {
    content: "Routing this request to the planner to create a task plan.",
    toolCalls: [
      {
        id: uuidv4(),
        name: toolName,
        args: {
          internal_reasoning:
            "User wants to create a web application. This is a new coding request that needs planning first.",
          response:
            "I'll help you create a Flask web application with a working button. Let me plan the implementation steps.",
          route: "feature_graph_orchestrator",
          needs_user_clarification: false,
        },
      },
    ],
  };
}

/**
 * Extract all message content for analysis
 */
function extractAllMessageContent(input: BaseLanguageModelInput): string {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "content" in item) {
          return getMessageContentString((item as BaseMessage).content);
        }
        return "";
      })
      .join(" ");
  }

  return "";
}

/**
 * Generate mock response based on bound tools and invocation state
 */
function generateMockResponse(
  input: BaseLanguageModelInput,
  boundTools: BindToolsInput[],
): {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
} {
  mockInvocationCount++;
  const lastContent = extractLastMessageContent(input).toLowerCase();
  const allContent = extractAllMessageContent(input).toLowerCase();

  // Get tool names for logging
  const toolNames = boundTools
    .map((t) => (typeof t === "object" && "name" in t ? t.name : "unknown"))
    .slice(0, 10);

  logger.info("generateMockResponse called", {
    invocationCount: mockInvocationCount,
    boundToolsCount: boundTools.length,
    toolNames,
    lastContentSnippet: lastContent.slice(0, 50),
    allContentLength: allContent.length,
  });

  // Detect classifier/router phase from message content
  // The classifier prompt mentions "routing options" and expects respond_and_route tool
  if (
    allContent.includes("routing options") ||
    allContent.includes("respond_and_route") ||
    allContent.includes("classify") ||
    allContent.includes("# assistant statuses")
  ) {
    logger.info("Classifier phase detected from content - generating route tool call");
    return generateClassificationToolCall("respond_and_route");
  }

  // Check if this is the classifier/router phase via bound tools
  const classifierTool = boundTools.find(
    (t) =>
      typeof t === "object" &&
      "name" in t &&
      typeof t.name === "string" &&
      (t.name.includes("structured") || t.name === "respond_and_route"),
  );
  if (classifierTool && typeof classifierTool === "object" && "name" in classifierTool) {
    logger.info("Classifier phase detected via tools - generating route tool call");
    return generateClassificationToolCall(classifierTool.name as string);
  }

  // Check if this is the feature graph agent phase (has create_feature tool)
  const hasCreateFeature = hasToolByName(boundTools, "create_feature");
  if (hasCreateFeature || allContent.includes("feature-graph concierge")) {
    logger.info("Feature graph agent phase detected - generating create_feature");
    return generateFeatureGraphToolCalls();
  }

  // IMPORTANT: Check for programmer tools - must have BOTH shell AND mark_task_completed
  // The planner's context-gathering phase also has a shell tool, but not mark_task_completed
  const hasShell = hasToolByName(boundTools, "shell");
  const hasMarkComplete = hasToolByName(boundTools, "mark_task_completed");
  if (hasShell && hasMarkComplete) {
    logger.info("Programmer phase detected (shell + mark_task_completed) - generating Flask app");
    return generateFlaskAppToolCalls(boundTools);
  }

  // Check if this is the planner phase (has session_plan tool bound)
  // Only detect planner by its bound tools, not content, to avoid false positives
  const hasSessionPlan = hasToolByName(boundTools, "session_plan");
  if (hasSessionPlan) {
    logger.info("Planner phase detected - generating session_plan");
    return generatePlanToolCalls();
  }

  // Handle write_technical_notes tool (notetaker phase)
  const hasWriteNotes = hasToolByName(boundTools, "write_technical_notes");
  if (hasWriteNotes) {
    logger.info("Notetaker phase detected - generating write_technical_notes");
    return {
      content: "I'll summarize the key technical notes from our context gathering.",
      toolCalls: [
        {
          id: uuidv4(),
          name: "write_technical_notes",
          args: {
            notes: "Mock technical notes for testing:\n- Flask web application with click counter\n- Uses templates/index.html for frontend\n- Backend routes: / (homepage), /click (POST endpoint)\n- Dependencies: flask==3.0.0",
          },
        },
      ],
    };
  }

  // Generic fallback: if there are bound tools but we don't have a specific handler,
  // this is likely the context-gathering phase with tools like grep, view, shell (read-only)
  if (boundTools.length > 0) {
    const firstTool = boundTools[0];
    if (typeof firstTool === "object" && "name" in firstTool) {
      const toolName = firstTool.name as string;

      // Check if this is a context-gathering phase (has multiple exploration tools)
      const hasGrep = hasToolByName(boundTools, "grep");
      const hasView = hasToolByName(boundTools, "view");
      const isContextGathering = hasGrep || hasView || hasToolByName(boundTools, "scratchpad");

      if (isContextGathering) {
        contextGatheringCount++;
        logger.info(`Context-gathering phase (call ${contextGatheringCount}/${MAX_CONTEXT_GATHERING_CALLS})`);

        // After MAX_CONTEXT_GATHERING_CALLS, stop making tool calls to break the loop
        if (contextGatheringCount > MAX_CONTEXT_GATHERING_CALLS) {
          logger.info("Context-gathering complete - returning without tool calls");
          contextGatheringCount = 0; // Reset for next run
          return {
            content: "I've gathered sufficient context. I'm ready to generate a plan for the Flask web application.",
            toolCalls: undefined,
          };
        }
      }

      logger.info(`Generic tool handler - generating call to ${toolName}`);

      // Generate appropriate mock args based on tool name
      const mockArgs = generateMockToolArgs(toolName);
      return {
        content: `[MOCK LLM] Generating tool call for: ${toolName}`,
        toolCalls: [
          {
            id: uuidv4(),
            name: toolName,
            args: mockArgs,
          },
        ],
      };
    }
  }

  // Default response for scenarios with no bound tools
  return {
    content: `[MOCK LLM] This is a mock response for testing purposes (invocation #${mockInvocationCount}).

The system is running in stub mode (OPEN_SWE_MOCK_LLM=true).
Request context: "${lastContent.slice(0, 100)}..."`,
    toolCalls: undefined,
  };
}

/**
 * Generate mock arguments for a given tool name
 */
function generateMockToolArgs(toolName: string): Record<string, any> {
  // Common tool argument patterns
  const argPatterns: Record<string, Record<string, any>> = {
    write_technical_notes: {
      notes: "Mock technical notes for testing purposes.",
    },
    session_plan: {
      title: "Mock Plan",
      plan: ["Step 1: Setup", "Step 2: Implementation", "Step 3: Testing"],
    },
    shell: {
      command: ["echo", "mock command"],
      timeout: 30,
    },
    mark_task_completed: {
      completed_task_summary: "Mock task completed successfully.",
    },
    create_feature: {
      featureId: "mock-feature",
      name: "Mock Feature",
      summary: "A mock feature for testing.",
    },
    respond_and_route: {
      internal_reasoning: "Mock routing decision.",
      response: "Mock response.",
      route: "feature_graph_orchestrator",
      needs_user_clarification: false,
    },
    determine_context: {
      reasoning: "For this mock demo, we already have sufficient context to generate a plan.",
      needs_more_context: false,
    },
    grep: {
      pattern: "mock",
      path: ".",
    },
    view: {
      path: "README.md",
    },
    scratchpad: {
      note: "Mock scratchpad note.",
    },
    get_url_content: {
      url: "https://example.com",
    },
  };

  return argPatterns[toolName] || { result: "mock_value" };
}

/**
 * MockChatModel - A stub LLM for testing without real API calls
 *
 * This model returns predictable responses that create a Flask web app
 * to test the preview/presentation feature.
 */
export class MockChatModel extends Runnable<
  BaseLanguageModelInput,
  AIMessageChunk
> {
  lc_namespace = ["langchain", "chat_models", "mock"];
  _llmType = "mock";

  private boundTools: BindToolsInput[] = [];
  private toolChoice: string | Record<string, any> | undefined;
  private config: RunnableConfig | undefined;

  // Store tool bindings in the format that FallbackRunnable.extractBoundTools() expects
  // This mimics LangChain's ConfigurableModel internal structure
  _queuedMethodOperations: {
    bindTools?: [BindToolsInput[], Record<string, any>];
  } = {};

  _defaultConfig = {
    modelProvider: "mock",
    model: "mock-model",
    maxTokens: 10000,
    temperature: 0,
  };

  constructor() {
    super({});
    logger.info("MockChatModel initialized - running in stub mode");
  }

  async invoke(
    input: BaseLanguageModelInput,
    _options?: RunnableConfig,
  ): Promise<AIMessageChunk> {
    const messageCount = Array.isArray(input) ? input.length : 1;

    logger.info("MockChatModel.invoke called", {
      messageCount,
      boundToolsCount: this.boundTools.length,
      toolChoice: this.toolChoice,
    });

    const { content, toolCalls } = generateMockResponse(input, this.boundTools);

    const response = new AIMessageChunk({
      id: uuidv4(),
      content,
      tool_calls: toolCalls,
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      },
    });

    logger.info("MockChatModel response generated", {
      contentLength: content.length,
      hasToolCalls: !!toolCalls?.length,
      toolCallNames: toolCalls?.map((tc) => tc.name),
    });

    return response;
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Record<string, any>,
  ): MockChatModel {
    const bound = new MockChatModel();
    bound.boundTools = tools;
    bound.toolChoice = kwargs?.tool_choice;
    bound.config = this.config;

    // Store in _queuedMethodOperations format for FallbackRunnable compatibility
    bound._queuedMethodOperations = {
      bindTools: [tools, kwargs ?? {}],
    };

    logger.debug("MockChatModel.bindTools called", {
      toolCount: tools.length,
      toolNames: tools
        .map((t) => (typeof t === "object" && "name" in t ? t.name : "unknown"))
        .slice(0, 10),
    });

    return bound;
  }

  withConfig(config?: RunnableConfig): MockChatModel {
    const configured = new MockChatModel();
    configured.boundTools = this.boundTools;
    configured.toolChoice = this.toolChoice;
    configured.config = config;
    // Preserve _queuedMethodOperations for FallbackRunnable compatibility
    configured._queuedMethodOperations = { ...this._queuedMethodOperations };
    return configured;
  }

  /**
   * Get the list of bound tools (for debugging)
   */
  getBoundTools(): BindToolsInput[] {
    return this.boundTools;
  }
}

/**
 * Create a mock model instance
 */
export function createMockModel(): MockChatModel {
  return new MockChatModel();
}
