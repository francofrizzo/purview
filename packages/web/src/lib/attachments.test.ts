import { describe, expect, it } from "vitest";
import {
  attachmentFileError,
  attachmentIdOf,
  attachmentMarkdown,
  attachmentRefs,
  insertAtSelection,
  isGithubAssetUrl,
  pendingAttachmentCount,
  removeAttachmentRef,
} from "./attachments";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("attachment references", () => {
  it("writes a reference whose alt text cannot break out of the image", () => {
    expect(attachmentMarkdown("shot.png", A)).toBe(`![shot.png](purview-attachment:${A})`);
    expect(attachmentMarkdown("a](x)\nb.png", A)).toBe(`![a\\](x) b.png](purview-attachment:${A})`);
  });

  it("finds each referenced id once, in order", () => {
    const body = `see ${attachmentMarkdown("a", A)}\n\n${attachmentMarkdown("b", B)} and ${attachmentMarkdown("a", A)}`;
    expect(attachmentRefs(body)).toEqual([A, B]);
    expect(attachmentRefs("plain")).toEqual([]);
  });

  it("tells local references from GitHub asset URLs and anything else", () => {
    expect(attachmentIdOf(`purview-attachment:${A}`)).toBe(A);
    expect(attachmentIdOf("https://github.com/user-attachments/assets/x")).toBeNull();
    expect(isGithubAssetUrl("https://github.com/user-attachments/assets/abc")).toBe(true);
    expect(isGithubAssetUrl("https://example.com/user-attachments/assets/abc")).toBe(false);
  });

  it("removes a reference with the whitespace that only separated it", () => {
    const body = `before\n\n${attachmentMarkdown("a", A)}\n\nafter ${attachmentMarkdown("b", B)}`;
    expect(removeAttachmentRef(body, A)).toBe(`before\n\nafter ${attachmentMarkdown("b", B)}`);
    expect(removeAttachmentRef(body, B)).toBe(`before\n\n${attachmentMarkdown("a", A)}\n\nafter`);
  });

  it("counts pictures still local on a draft, none once pushed", () => {
    const body = `${attachmentMarkdown("a", A)} ${attachmentMarkdown("b", B)}`;
    expect(pendingAttachmentCount({ body, status: "draft" })).toBe(2);
    expect(pendingAttachmentCount({ body })).toBe(2);
    expect(pendingAttachmentCount({ body, status: "pushed" })).toBe(0);
  });
});

describe("insertAtSelection", () => {
  it("puts a picture on its own line in the middle of text", () => {
    const r = insertAtSelection("one two", { start: 3, end: 3 }, "![x](y)");
    expect(r.body).toBe("one\n![x](y)\n two");
    expect(r.caret).toBe("one\n![x](y)\n".length);
  });

  it("adds no blank lines when it already sits on one, and replaces a selection", () => {
    expect(insertAtSelection("", { start: 0, end: 0 }, "![x](y)").body).toBe("![x](y)");
    expect(insertAtSelection("a\n", { start: 2, end: 2 }, "![x](y)").body).toBe("a\n![x](y)");
    expect(insertAtSelection("abc", { start: 0, end: 3 }, "![x](y)").body).toBe("![x](y)");
  });
});

describe("attachmentFileError", () => {
  it("accepts GitHub's image and video types by extension or mime, within gh's limits", () => {
    expect(attachmentFileError({ name: "shot.png", type: "image/png", size: 10 })).toBeNull();
    expect(attachmentFileError({ name: "image", type: "image/jpeg", size: 10 })).toBeNull();
    expect(attachmentFileError({ name: "clip.mov", type: "", size: 50 * 1024 * 1024 })).toBeNull();
  });

  it("names the problem for a wrong type, an empty file or an oversize one", () => {
    expect(attachmentFileError({ name: "notes.txt", type: "text/plain", size: 10 })).toMatch(/not an image/);
    expect(attachmentFileError({ name: "shot.png", type: "image/png", size: 0 })).toMatch(/empty/);
    expect(attachmentFileError({ name: "shot.png", type: "image/png", size: 10 * 1024 * 1024 + 1 })).toMatch(
      /at most 10 MB/,
    );
  });
});
