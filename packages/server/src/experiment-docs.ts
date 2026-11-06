/**
 * Skill docs carry the guidance for experiments between markers:
 *
 *   <!-- experiment:unitDiagrams -->
 *   ...
 *   <!-- /experiment:unitDiagrams -->
 *
 * A run is shown a block only while its experiment is on, so with the flag
 * off the prompt is the one it was before the experiment existed. The
 * markers themselves never reach a run.
 */
const BLOCK = /^<!-- experiment:([A-Za-z]+) -->\n([\s\S]*?)^<!-- \/experiment:\1 -->\n?/gm;

export function withExperiments(doc: string, on: (id: string) => boolean): string {
  return doc.replace(BLOCK, (_all, id: string, body: string) => (on(id) ? body : ""));
}
