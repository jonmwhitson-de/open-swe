# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Open SWE is an open-source cloud-based asynchronous coding agent built with LangGraph by LangChain. It autonomously understands codebases, plans solutions, and executes code changes across entire repositories.

## Repository Structure

This is a Yarn workspace monorepo with Turbo build orchestration:

- **apps/open-swe**: LangGraph agent application (core agent implementation)
- **apps/open-swe-v2**: Newer version of the agent
- **apps/web**: Next.js 15 web interface with React 19, Shadcn UI, and Tailwind CSS
- **apps/cli**: Command-line interface
- **apps/docs**: Documentation site
- **packages/shared**: Common utilities (@openswe/shared namespace)
- **packages/sandbox-core**: Core sandbox functionality
- **packages/sandbox-docker**: Docker sandbox implementation

## Essential Commands

```bash
# Install dependencies (always use Yarn, never npm)
yarn install

# Build all packages (handles dependencies via Turbo)
yarn build

# Development mode
yarn dev

# Linting and formatting
yarn lint
yarn lint:fix
yarn format
yarn format:check

# Testing
yarn test           # Run unit tests
yarn test:int       # Run integration tests (apps/open-swe only)

# Docker
yarn sandbox:build  # Build sandbox Docker image
yarn stack:up       # Start local Docker stack
yarn stack:down     # Stop local Docker stack
```

## Code Style Guidelines

- Use Yarn exclusively as the package manager
- Follow strict TypeScript practices (strict mode enabled)
- Run `yarn lint:fix` and `yarn format` before committing
- No console.log in apps/open-swe - use `createLogger` instead
- Import from shared package using `@openswe/shared/<module>` paths
- Keep inline comments minimal
- Build shared package first before other packages can consume it

## Architecture Notes

- The agent has three graphs: programmer, planner, and manager (see langgraph.json)
- Web UI uses Shadcn UI (wrapped Radix UI components) with Tailwind CSS
- Dependencies should be installed in their specific app/package, not at root
- Tests use Jest with ts-jest preset and ESM module handling

## Local Development

1. Pull or build the sandbox image:
   ```bash
   docker pull ghcr.io/langchain-ai/open-swe/sandbox:latest
   # Or build locally:
   docker build -f Dockerfile.sandbox -t ghcr.io/langchain-ai/open-swe/sandbox:latest .
   ```

2. Configure environment variables (LLM API keys, etc.)

3. Start the stack:
   ```bash
   docker compose up
   ```
   This runs the LangGraph agent on port 2024 and web UI on port 3000.
