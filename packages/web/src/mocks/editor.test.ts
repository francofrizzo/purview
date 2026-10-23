import { expect, it } from "vitest";
import { mockApi } from "./server";

it("keeps the custom editor name when saving config", async () => {
  const original = (await mockApi.getConfig()).editor;
  const editor = { id: "custom", name: "Nova", command: "nova {path}" };
  try {
    expect((await mockApi.saveConfig({ editor })).editor).toEqual(editor);
    expect((await mockApi.getConfig()).editor).toEqual(editor);
  } finally {
    await mockApi.saveConfig({ editor: original ?? null });
  }
});
