import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "weavatrix-java-"));
  for (const [relative, source] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

const endpoint = (value) => typeof value === "string" ? value : value?.id;

test("java graph: owns methods and resolves internal extends, implements and type references", async () => {
  const root = fixture({
    "src/base/Parent.java": "package base; public class Parent { protected void inherited() {} }\n",
    "src/api/BaseContract.java": "package api; public interface BaseContract {}\n",
    "src/api/Contract.java": "package api; public interface Contract extends BaseContract { void handle(); }\n",
    "src/model/Marker.java": "package model; public interface Marker {}\n",
    "src/model/Payload.java": "package model; public record Payload(String value) implements Marker {}\n",
    "src/util/Helpers.java": "package util; public class Helpers { public static void help() {} }\n",
    "src/app/Sibling.java": "package app; public class Sibling {}\n",
    "src/app/Child.java": [
      "package app;",
      "import base.Parent;",
      "import api.Contract;",
      "import model.Payload;",
      "import static util.Helpers.help;",
      "public class Child extends Parent implements Contract, java.io.Serializable {",
      "  private Payload payload;",
      "  public Child(Payload payload) { this.payload = payload; }",
      "  public Payload handle(Payload input) { help(); return input; }",
      "  void sibling(Sibling value) {}",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const graph = await buildInternalGraph(root);
    const symbol = (file, name, line) => graph.nodes.find((node) =>
      node.source_file === file && endpoint(node.id).includes(`#${name}@`) && (!line || node.source_location === `L${line}`));
    const child = symbol("src/app/Child.java", "Child", 6);
    const constructor = symbol("src/app/Child.java", "Child", 8);
    const handle = symbol("src/app/Child.java", "handle", 9);
    const field = symbol("src/app/Child.java", "payload", 7);
    const parent = symbol("src/base/Parent.java", "Parent");
    const contract = symbol("src/api/Contract.java", "Contract");
    const baseContract = symbol("src/api/BaseContract.java", "BaseContract");
    const payload = symbol("src/model/Payload.java", "Payload");
    const marker = symbol("src/model/Marker.java", "Marker");
    const sibling = symbol("src/app/Sibling.java", "Sibling");
    const helper = symbol("src/util/Helpers.java", "help");

    assert.ok(child && constructor && handle && field && parent && contract && baseContract && payload && marker && sibling && helper);
    assert.equal(child.symbol_kind, "class");
    assert.equal(handle.symbol_kind, "method");
    assert.equal(handle.member_of, "Child");
    assert.equal(handle.visibility, "public");
    assert.equal(constructor.symbol_kind, "constructor");
    assert.equal(field.symbol_kind, "field");
    assert.equal(field.member_of, "Child");
    assert.equal(field.visibility, "private");

    const edge = (relation, source, target) => graph.links.some((link) =>
      link.relation === relation && endpoint(link.source) === endpoint(source) && endpoint(link.target) === endpoint(target));
    assert.ok(edge("method", child, constructor), "class owns its constructor");
    assert.ok(edge("method", child, handle), "class owns its method");
    assert.ok(edge("inherits", child, parent), "extends resolves to the imported project class");
    assert.ok(edge("implements", child, contract), "implements remains distinct from extends");
    assert.ok(edge("inherits", contract, baseContract), "interface extends resolves as inheritance");
    assert.ok(edge("implements", payload, marker), "record implements resolves to its same-package interface");
    assert.ok(edge("references", handle, payload), "method signature type resolves to its project declaration");
    assert.ok(graph.links.some((link) => link.relation === "references" && endpoint(link.target) === sibling.id), "same-package type resolves without an import");
    assert.ok(edge("calls", handle, helper), "existing calls survive and explicit static imports resolve");

    assert.ok(graph.links.some((link) => link.relation === "imports" && link.compileOnly === true && endpoint(link.source) === "src/app/Child.java" && endpoint(link.target) === "src/base/Parent.java"));
    assert.ok(!graph.nodes.some((node) => node.label === "Serializable"), "external types do not become synthetic graph nodes");
    assert.ok(!graph.links.some((link) => link.relation === "implements" && endpoint(link.source) === child.id && String(endpoint(link.target)).includes("Serializable")), "unresolved external interfaces are not fake internal edges");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("java graph: overloaded and nested methods keep the nearest declaring type as owner", async () => {
  const root = fixture({
    "Nested.java": [
      "class Outer {",
      "  void work() {}",
      "  void work(int value) {}",
      "  class Inner {",
      "    protected void work(String value) {}",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const graph = await buildInternalGraph(root);
    const methods = graph.nodes.filter((node) => node.source_file === "Nested.java" && node.label === "work()");
    assert.equal(methods.length, 3);
    assert.deepEqual(methods.map((node) => node.member_of), ["Outer", "Outer", "Inner"]);
    assert.equal(methods[2].visibility, "protected");
    for (const method of methods) {
      const owner = graph.nodes.find((node) => node.source_file === "Nested.java" && node.label === method.member_of);
      assert.ok(graph.links.some((link) => link.relation === "method" && endpoint(link.source) === owner.id && endpoint(link.target) === method.id));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("java graph: an external import cannot bind to a same-basename project class", async () => {
  const root = fixture({
    "src/test/KafkaConsumer.java": "package test; public class KafkaConsumer {}\n",
    "src/app/UsesExternal.java": [
      "package app;",
      "import org.apache.kafka.clients.consumer.KafkaConsumer;",
      "public class UsesExternal { private KafkaConsumer consumer; }",
      "",
    ].join("\n"),
  });
  try {
    const graph = await buildInternalGraph(root);
    const local = graph.nodes.find((node) => node.source_file === "src/test/KafkaConsumer.java" && node.label === "KafkaConsumer");
    assert.ok(local);
    assert.ok(!graph.links.some((link) => endpoint(link.target) === local.id && ["imports", "references"].includes(link.relation)), "package mismatch prevents basename fallback from inventing a dependency");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("java graph: compact same-line constructors and overloads keep unique owned symbols", async () => {
  const root = fixture({
    "Child.java": "public class Child { void Child() {} Child() {} void work() {} void work(int value) {} }\n",
  });
  try {
    const graph = await buildInternalGraph(root);
    const symbols = graph.nodes.filter((node) => node.source_file === "Child.java" && String(node.id).includes("#"));
    const owner = symbols.find((node) => node.symbol_kind === "class" && node.label === "Child");
    const members = symbols.filter((node) => ["method", "constructor"].includes(node.symbol_kind));
    assert.ok(owner);
    assert.equal(members.length, 4, "constructor, same-named method and both overloads survive");
    assert.equal(new Set(symbols.map((node) => node.id)).size, symbols.length, "all compact symbols have unique IDs");
    const ownership = graph.links.filter((link) => link.relation === "method" && endpoint(link.source) === owner.id);
    assert.equal(ownership.length, 4);
    assert.ok(ownership.every((link) => endpoint(link.source) !== endpoint(link.target)), "ownership never becomes a self-edge");
    assert.deepEqual(new Set(ownership.map((link) => endpoint(link.target))), new Set(members.map((node) => node.id)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
