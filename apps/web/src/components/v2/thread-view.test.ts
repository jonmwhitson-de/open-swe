import { describe, expect, it } from "vitest";

import { shouldAutoGenerateFeatureGraph, shouldMarkFeatureRunComplete } from "./thread-view";

describe("shouldAutoGenerateFeatureGraph", () => {
  it("returns false when planner stream is loading", () => {
    expect(
      shouldAutoGenerateFeatureGraph({
        plannerIsLoading: true,
        programmerIsLoading: false,
        hasPlannerSession: false,
        hasProgrammerSession: false,
      }),
    ).toBe(false);
  });

  it("returns false when programmer stream is loading", () => {
    expect(
      shouldAutoGenerateFeatureGraph({
        plannerIsLoading: false,
        programmerIsLoading: true,
        hasPlannerSession: false,
        hasProgrammerSession: false,
      }),
    ).toBe(false);
  });

  it("returns false when a planner or programmer session is active", () => {
    expect(
      shouldAutoGenerateFeatureGraph({
        plannerIsLoading: false,
        programmerIsLoading: false,
        hasPlannerSession: true,
        hasProgrammerSession: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoGenerateFeatureGraph({
        plannerIsLoading: false,
        programmerIsLoading: false,
        hasPlannerSession: false,
        hasProgrammerSession: true,
      }),
    ).toBe(false);
  });

  it("allows auto generation when no sessions are active", () => {
    expect(
      shouldAutoGenerateFeatureGraph({
        plannerIsLoading: false,
        programmerIsLoading: false,
        hasPlannerSession: false,
        hasProgrammerSession: false,
      }),
    ).toBe(true);
  });
});

describe("shouldMarkFeatureRunComplete", () => {
  const completedTaskPlan = {
    tasks: [{ completed: true }],
    activeTaskIndex: 0,
  };

  const incompleteTaskPlan = {
    tasks: [{ completed: false }],
    activeTaskIndex: 0,
  };

  it("returns false when status is not running", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "completed",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);

    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "idle",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);
  });

  it("returns false when programmer session from planner does not exist", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: undefined,
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);

    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: undefined },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);
  });

  it("returns false when programmerStream is watching a different thread", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-2", // Different thread
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);
  });

  it("returns false when programmer is still loading", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: true, // Still loading
        taskPlan: completedTaskPlan,
      }),
    ).toBe(false);
  });

  it("returns false when active task is not completed", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: incompleteTaskPlan,
      }),
    ).toBe(false);
  });

  it("returns false when taskPlan is undefined", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: undefined,
      }),
    ).toBe(false);
  });

  it("returns true when all conditions are met", () => {
    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: completedTaskPlan,
      }),
    ).toBe(true);
  });

  it("returns true with multiple tasks where active task is completed", () => {
    const multiTaskPlan = {
      tasks: [
        { completed: true },
        { completed: true },
        { completed: false },
      ],
      activeTaskIndex: 1, // Second task is active and completed
    };

    expect(
      shouldMarkFeatureRunComplete({
        currentStatus: "running",
        programmerSessionFromPlanner: { threadId: "thread-1" },
        programmerSessionThreadId: "thread-1",
        programmerIsLoading: false,
        taskPlan: multiTaskPlan,
      }),
    ).toBe(true);
  });
});
