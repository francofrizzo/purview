/**
 * The mock backend has to layer agents the same way the server does, or mock
 * mode quietly disagrees with the real thing about what a run will cost.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockApi } from "./server";

const BILLING = "github.com/acme/billing";
const PLATFORM = "github.com/acme/platform";
const TERRAFORM = "git.acme.dev/infra/terraform-modules";
const CC = "claude-code";

beforeEach(async () => {
  // The store is module-level and mutable; reset what these tests touch.
  await mockApi.saveConfig({ analysisAgent: null, chatAgent: null });
  await mockApi.saveRepoConfig(BILLING, { analysisAgent: { harness: CC, model: "opus" }, chatAgent: null });
  await mockApi.saveRepoConfig(PLATFORM, { analysisAgent: null, chatAgent: null });
});

describe("repo agent layering", () => {
  it("falls back to the harness's defaults when no layer says anything", async () => {
    const config = await mockApi.getRepoConfig(PLATFORM);
    expect(config.effective.analysisAgent).toEqual({
      harness: CC,
      model: "sonnet",
      effort: "medium",
      sources: { harness: "default", model: "default", effort: "default" },
    });
    expect(config.effective.chatAgent).toMatchObject({ model: "sonnet", sources: { model: "default" } });
  });

  it("prefers the repo's own setting over everything else", async () => {
    const config = await mockApi.getRepoConfig(BILLING);
    expect(config.effective.analysisAgent).toMatchObject({ model: "opus", sources: { model: "repo" } });
    // ...and what it does not set still inherits.
    expect(config.effective.analysisAgent.sources.effort).toBe("default");
    expect(config.effective.chatAgent.sources.model).toBe("default");
  });

  it("takes the committed team config when the repo is silent", async () => {
    const config = await mockApi.getRepoConfig(TERRAFORM);
    expect(config.effective.analysisAgent).toMatchObject({ model: "opus", sources: { model: "committed" } });
    expect(config.effective.chatAgent).toMatchObject({ model: "haiku", sources: { model: "committed" } });
  });

  it("lets the global layer decide, but only under the committed one", async () => {
    await mockApi.saveConfig({
      analysisAgent: { harness: CC, model: "haiku" },
      chatAgent: { harness: CC, model: "haiku" },
    });

    const platform = await mockApi.getRepoConfig(PLATFORM);
    expect(platform.effective.analysisAgent).toMatchObject({ model: "haiku", sources: { model: "global" } });
    expect(platform.effective.chatAgent).toMatchObject({ model: "haiku", sources: { model: "global" } });

    // The committed config outranks it.
    const terraform = await mockApi.getRepoConfig(TERRAFORM);
    expect(terraform.effective.chatAgent).toMatchObject({ model: "haiku", sources: { model: "committed" } });

    // The repo's own setting outranks both.
    const billing = await mockApi.getRepoConfig(BILLING);
    expect(billing.effective.analysisAgent).toMatchObject({ model: "opus", sources: { model: "repo" } });
    expect(billing.effective.chatAgent).toMatchObject({ model: "haiku", sources: { model: "global" } });
  });

  it("a null write re-inherits rather than pinning", async () => {
    await mockApi.saveRepoConfig(BILLING, { analysisAgent: { harness: CC, model: "haiku" } });
    expect((await mockApi.getRepoConfig(BILLING)).effective.analysisAgent.model).toBe("haiku");
    const cleared = await mockApi.saveRepoConfig(BILLING, { analysisAgent: null });
    expect(cleared.local.analysisAgent).toBeNull();
    expect(cleared.effective.analysisAgent).toMatchObject({ model: "sonnet", sources: { model: "default" } });
  });

  it("reports what the global layer resolves to, so 'inherit' can be labelled", async () => {
    const config = await mockApi.getConfig();
    expect(config.effective.analysisAgent).toMatchObject({ harness: CC, model: "sonnet", effort: "medium" });
    expect(config.effective.chatAgent).toMatchObject({ harness: CC, model: "sonnet" });
  });

  it("lists the harness manifests the settings are built from", async () => {
    const agents = await mockApi.getAgents();
    expect(agents.default).toBe(CC);
    expect(agents.harnesses.map((h) => h.id)).toEqual([CC]);
  });
});

describe("per-chat agent", () => {
  const key = `${PLATFORM}/1`;

  it("starts on the repo's effective chat agent, unpinned", async () => {
    await mockApi.setChatAgent(key, null);
    const state = await mockApi.getChat(key);
    expect(state).toMatchObject({
      agent: { harness: CC, model: "sonnet" },
      configuredAgent: { model: "sonnet", sources: { model: "default" } },
      sessionAgent: null,
    });
  });

  it("pins a model for the conversation without restarting the session", async () => {
    const result = await mockApi.setChatAgent(key, { harness: CC, model: "opus" });
    expect(result).toMatchObject({
      agent: { model: "opus", sources: { model: "chat" } },
      sessionAgent: { harness: CC, model: "opus" },
      configuredAgent: { model: "sonnet" },
      restartedSession: false,
    });
    expect(await mockApi.getChat(key)).toMatchObject({
      agent: { model: "opus" },
      sessionAgent: { model: "opus" },
    });
  });

  it("follows the configured agent again once unpinned", async () => {
    await mockApi.setChatAgent(key, { harness: CC, model: "opus" });
    await mockApi.saveConfig({ chatAgent: { harness: CC, model: "haiku" } });
    await mockApi.setChatAgent(key, null);
    expect(await mockApi.getChat(key)).toMatchObject({
      agent: { model: "haiku" },
      configuredAgent: { model: "haiku" },
      sessionAgent: null,
    });
  });

  it("drops the pin when the conversation is cleared", async () => {
    await mockApi.setChatAgent(key, { harness: CC, model: "opus" });
    await mockApi.clearChat(key);
    expect(await mockApi.getChat(key)).toMatchObject({ agent: { model: "sonnet" }, sessionAgent: null });
  });

  it("rejects a model the harness does not offer", async () => {
    await expect(mockApi.setChatAgent(key, { harness: CC, model: "gpt-9" })).rejects.toThrow();
  });
});
