import { MetaSchema, readMeta, stateRoot, writeMeta, type PrKey } from "@reviewer/core";

export const TagSchema = MetaSchema.shape.tag.unwrap();

export function setTagFor(key: PrKey, tag: string | null, root = stateRoot()) {
  const { tag: _drop, ...rest } = readMeta(key, root);
  const meta = tag === null ? rest : { ...rest, tag: TagSchema.parse(tag) };
  writeMeta(key, meta, root);
  return meta;
}
