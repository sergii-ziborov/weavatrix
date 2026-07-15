import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDuplicates } from "../src/analysis/duplicates.js";

// Two TS files each embedding a near-identical multi-line template literal (C#-flavoured), with the
// second copy's identifiers renamed — invisible to the normal pass (string bodies are stripped),
// caught by include_strings.
const CS_BODY = (cls) => `
using System;
using System.Runtime.InteropServices;
public class ${cls} {
    [DllImport("wlanapi.dll")] public static extern int WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] public static extern int WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] public static extern void WlanFreeMemory(IntPtr memory);
    public static void Run() {
        IntPtr handle; uint negotiated;
        WlanOpenHandle(2, IntPtr.Zero, out negotiated, out handle);
        IntPtr list; WlanEnumInterfaces(handle, IntPtr.Zero, out list);
        var count = Marshal.ReadInt32(list, 0);
        WlanFreeMemory(list);
    }
}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wx-dup-str-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "scan.ts"), "export const SCAN_SCRIPT = `" + CS_BODY("Scanner") + "`;\n");
  writeFileSync(join(dir, "src", "bss.ts"), "export const BSS_SCRIPT = `" + CS_BODY("BssReader") + "`;\n");
  // Hand-written graph: one symbol per file so both files enter the fragment pass.
  const graph = {
    nodes: [
      { id: "src/scan.ts", label: "scan.ts", source_file: "src/scan.ts", file_type: "code" },
      { id: "src/bss.ts", label: "bss.ts", source_file: "src/bss.ts", file_type: "code" },
      { id: "src/scan.ts#SCAN_SCRIPT@1", label: "SCAN_SCRIPT", source_file: "src/scan.ts", source_location: "L1" },
      { id: "src/bss.ts#BSS_SCRIPT@1", label: "BSS_SCRIPT", source_file: "src/bss.ts", source_location: "L1" },
    ],
    links: [],
  };
  writeFileSync(join(dir, "graph.json"), JSON.stringify(graph));
  return dir;
}

test("find_duplicates: string-literal clones are invisible by default and found with includeStrings", () => {
  const dir = fixture();
  try {
    const plain = computeDuplicates(dir, join(dir, "graph.json"));
    assert.ok(!plain.frags.some((f) => String(f.id).includes("#str@")), "no string fragments by default");

    const withStr = computeDuplicates(dir, join(dir, "graph.json"), { includeStrings: true });
    const strFrags = withStr.frags.filter((f) => String(f.id).includes("#str@"));
    assert.equal(strFrags.length, 2, "both template literals extracted as fragments");
    assert.ok(strFrags.every((f) => f.kind === "string"), "string fragments carry kind");
    const pair = withStr.modes.renamed.find(([i, j]) =>
      String(withStr.frags[i].id).includes("#str@") && String(withStr.frags[j].id).includes("#str@"));
    assert.ok(pair, "renamed-mode pair links the two string literals");
    assert.ok(pair[2] >= 80, `similarity ${pair[2]}% ≥ 80`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
