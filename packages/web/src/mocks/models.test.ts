/**
 * The mock backend has to layer models the same way the server does, or mock
 * mode quietly disagrees with the real thing about what a run will cost.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockApi } from "./server";

const BILLING = "github.com/acme/billing";
const PLATFORM = "github.com/acme/platform";
const TERRAFORM = "git.acme.dev/infra/terraform-modules";

beforeEach(async () => {
  // The store is module-level and mutable; reset what these tests touch.
  await mockApi.saveConfig({ analysisModel: null, chatModel: null });
  await mockApi.saveRepoConfig(BILLING, { analysisModel: "opus", chatModel: null });
  await mockApi.saveRepoConfig(PLATFORM, { analysisModel: null, chatModel: null });
});

describe("repo model layering", () => {
  it("falls back to the built-in sonnet when no layer says anything", async () => {
    const config = await mockApi.getRepoConfig(PLATFORM);
    expect(config.effective).toMatchObject({ analysisModel: "sonnet", chatModel: "sonnet" });
    expect(config.sources).toMatchObject({ analysisModel: "default", chatModel: "default" });
  });

  it("prefers the repo's own setting over everything else", async () => {
    const config = await mockApi.getRepoConfig(BILLING);
    expect(config.effective.analysisModel).toBe("opus");
    expect(config.sources?.analysisModel).toBe("repo");
    // ...and the key it does not set still inherits.
    expect(config.sources?.chatModel).toBe("default");
  });

  it("takes the committed team config when the repo is silent", async () => {
    const config = await mockApi.getRepoConfig(TERRAFORM);
    expect(config.effective).toMatchObject({ analysisModel: "opus", chatModel: "haiku" });
    expect(config.sources).toMatchObject({ analysisModel: "committed", chatModel: "committed" });
  });

  it("lets the global layer decide, but only under the committed one", async () => {
    await mockApi.saveConfig({ analysisModel: "haiku", chatModel: "haiku" });

    const platform = await mockApi.getRepoConfig(PLATFORM);
    expect(platform.effective).toMatchObject({ analysisModel: "haiku", chatModel: "haiku" });
    expect(platform.sources).toMatchObject({ analysisModel: "global", chatModel: "global" });

    // The committed config outranks it.
    const terraform = await mockApi.getRepoConfig(TERRAFORM);
    expect(terraform.sources?.chatModel).toBe("committed");
    expect(terraform.effective.chatModel).toBe("haiku");

    // The repo's own setting outranks both.
    const billing = await mockApi.getRepoConfig(BILLING);
    expect(billing.effective.analysisModel).toBe("opus");
    expect(billing.effective.chatModel).toBe("haiku");
    expect(billing.sources).toMatchObject({ analysisModel: "repo", chatModel: "global" });
  });

  it("a null write re-inherits rather than pinning", async () => {
    await mockApi.saveRepoConfig(BILLING, { analysisModel: "haiku" });
    expect((await mockApi.getRepoConfig(BILLING)).effective.analysisModel).toBe("haiku");
    const cleared = await mockApi.saveRepoConfig(BILLING, { analysisModel: null });
    expect(cleared.local.analysisModel).toBeNull();
    expect(cleared.effective.analysisModel).toBe("sonnet");
    expect(cleared.sources?.analysisModel).toBe("default");
  });

  it("reports the global defaults so 'inherit' can be labelled", async () => {
    const config = await mockApi.getConfig();
    expect(config.defaults).toEqual({ analysisModel: "sonnet", chatModel: "sonnet" });
  });
});

describe("per-chat model", () => {
  const key = `${PLATFORM}/1`;

  it("starts on the repo's effective chat model, unpinned", async () => {
    await mockApi.setChatModel(key, null);
    const state = await mockApi.getChat(key);
    expect(state).toMatchObject({
      model: "sonnet",
      configuredModel: "sonnet",
      configuredModelSource: "default",
      sessionModel: null,
    });
  });

  it("pins a model for the conversation without restarting the session", async () => {
    const result = await mockApi.setChatModel(key, "opus");
    expect(result).toMatchObject({
      model: "opus",
      sessionModel: "opus",
      configuredModel: "sonnet",
      restartedSession: false,
    });
    expect(await mockApi.getChat(key)).toMatchObject({ model: "opus", sessionModel: "opus" });
  });

  it("follows the configured model again once unpinned", async () => {
    await mockApi.setChatModel(key, "opus");
    await mockApi.saveConfig({ chatModel: "haiku" });
    await mockApi.setChatModel(key, null);
    expect(await mockApi.getChat(key)).toMatchObject({
      model: "haiku",
      configuredModel: "haiku",
      sessionModel: null,
    });
  });

  it("drops the pin when the conversation is cleared", async () => {
    await mockApi.setChatModel(key, "opus");
    await mockApi.clearChat(key);
    expect(await mockApi.getChat(key)).toMatchObject({ model: "sonnet", sessionModel: null });
  });
});
