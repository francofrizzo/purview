import { mockApi } from "../mocks/server";
import type {
  DraftComment,
  MigrationReport,
  PrDetail,
  PrListEntry,
  ReviewUnit,
  SyncResult,
} from "./types";

export const MOCK = import.meta.env.VITE_MOCK === "1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      (typeof body === "object" && body && "error" in body && String((body as any).error)) ||
      (typeof body === "string" && body) ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const encodeKey = (key: string) => encodeURIComponent(key);

/** The server may answer with a bare array or an envelope; tolerate both. */
function unwrap<T>(value: unknown, field: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as any)[field])) {
    return (value as any)[field] as T[];
  }
  return [];
}

export const api = {
  async listPrs(): Promise<PrListEntry[]> {
    if (MOCK) return mockApi.listPrs();
    return unwrap<PrListEntry>(await request<unknown>("/prs"), "prs");
  },

  async addPr(url: string): Promise<PrListEntry> {
    if (MOCK) return mockApi.addPr(url);
    return post<PrListEntry>("/prs", { url });
  },

  async getPr(key: string): Promise<PrDetail> {
    if (MOCK) return mockApi.getPr(key);
    const raw = await request<PrDetail>(`/prs/${encodeKey(key)}`);
    return { ...raw, key: raw.key ?? key };
  },

  async refresh(key: string): Promise<MigrationReport> {
    if (MOCK) return mockApi.refresh(key);
    return post<MigrationReport>(`/prs/${encodeKey(key)}/refresh`);
  },

  async sync(key: string): Promise<SyncResult> {
    if (MOCK) return mockApi.sync(key);
    return post<SyncResult>(`/prs/${encodeKey(key)}/sync`);
  },

  async setHunkViewed(key: string, hunkId: string, viewed: boolean): Promise<void> {
    if (MOCK) return mockApi.setHunkViewed(key, hunkId, viewed);
    await post(`/prs/${encodeKey(key)}/hunks/${encodeURIComponent(hunkId)}/viewed`, { viewed });
  },

  async setUnitViewed(key: string, unitId: string): Promise<void> {
    if (MOCK) return mockApi.setUnitViewed(key, unitId);
    await post(`/prs/${encodeKey(key)}/units/${encodeURIComponent(unitId)}/viewed`);
  },

  async patchUnit(key: string, unitId: string, patch: Partial<ReviewUnit>): Promise<void> {
    if (MOCK) return mockApi.patchUnit(key, unitId, patch);
    await post(`/prs/${encodeKey(key)}/units/${encodeURIComponent(unitId)}`, patch);
  },

  async listComments(key: string): Promise<DraftComment[]> {
    if (MOCK) return mockApi.listComments(key);
    return unwrap<DraftComment>(
      await request<unknown>(`/prs/${encodeKey(key)}/comments`),
      "comments",
    );
  },

  async addComment(
    key: string,
    input: { file: string; line: number; side: "LEFT" | "RIGHT"; body: string },
  ): Promise<DraftComment> {
    if (MOCK) return mockApi.addComment(key, input);
    return post<DraftComment>(`/prs/${encodeKey(key)}/comments`, input);
  },
};
