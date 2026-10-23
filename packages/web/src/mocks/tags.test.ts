import { expect, it } from "vitest";
import { mockApi } from "./server";

it("persists normalized tags in list and detail, and removes them", async () => {
  const key = "github.com/acme/billing/502";
  const original = (await mockApi.getPr(key)).meta.tag;
  try {
    await mockApi.setPrTag(key, "  Alpha \n Team ");
    expect((await mockApi.listPrs()).find((p) => p.key === key)?.meta.tag).toBe("alpha team");
    expect((await mockApi.getPr(key)).meta.tag).toBe("alpha team");
    await mockApi.setPrTag(key, null);
    expect((await mockApi.getPr(key)).meta.tag).toBeUndefined();
    expect((await mockApi.listPrs()).find((p) => p.key === key)?.meta.tag).toBeUndefined();
    await expect(mockApi.setPrTag(key, " ")).rejects.toThrow();
  } finally {
    await mockApi.setPrTag(key, original ?? null);
  }
});
