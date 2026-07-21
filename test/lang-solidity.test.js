import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalGraph } from "../src/graph/internal-builder.js";

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "wx-sol-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const BASE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

uint256 constant FEE_BPS = 30;

abstract contract Base {
    uint256 public total;
    mapping(address => uint256) balances;
    event Deposited(address indexed who, uint256 amount);
    error NotOwner(address caller);
    modifier onlyPositive(uint256 v) { require(v > 0); _; }
}
`;

const ITOKEN = `pragma solidity ^0.8.20;

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
}
`;

const VAULT = `pragma solidity ^0.8.20;

import "./Base.sol";
import {IToken} from "./interfaces/IToken.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@shared/Math.sol";

contract Vault is Base, IToken {
    struct Position { uint128 size; uint128 entry; }
    enum Mode { Open, Closed }
    IToken private token;

    constructor(IToken t) { token = t; }

    function deposit(uint256 amount) external onlyPositive(amount) {
        balances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return token.transfer(to, amount);
    }
}
`;

const MATH = `pragma solidity ^0.8.20;

library MathLib {
    function half(uint256 x) internal pure returns (uint256) { return x / 2; }
}
`;

test("lang-solidity: symbols, inheritance, modifier/emit calls, imports and remappings", async () => {
  const dir = repoWith({
    "remappings.txt": "@shared/=shared-sol/\n",
    "src/Base.sol": BASE,
    "src/Vault.sol": VAULT,
    "src/interfaces/IToken.sol": ITOKEN,
    "shared-sol/Math.sol": MATH,
  });
  try {
    const g = await buildInternalGraph(dir);
    const sym = (name) => g.nodes.find((n) => String(n.id).includes("#" + name + "@"));
    for (const name of ["Base", "Vault", "IToken", "MathLib", "FEE_BPS", "deposit", "onlyPositive", "Deposited", "NotOwner", "Position", "Mode", "half", "total"]) {
      assert.ok(sym(name), `symbol ${name} extracted`);
    }
    assert.equal(sym("Base").symbol_kind, "contract");
    assert.equal(sym("IToken").symbol_kind, "interface");
    assert.equal(sym("MathLib").symbol_kind, "library");
    assert.equal(sym("onlyPositive").symbol_kind, "modifier");
    assert.equal(sym("Deposited").symbol_kind, "event");
    assert.equal(sym("NotOwner").symbol_kind, "error");
    assert.equal(sym("Position").symbol_kind, "struct");
    assert.equal(sym("Mode").symbol_kind, "enum");
    assert.equal(sym("FEE_BPS").symbol_kind, "constant");
    assert.equal(sym("total").symbol_kind, "variable");
    assert.equal(sym("Base").exported, true);

    const deposit = g.nodes.find((n) => n.source_file === "src/Vault.sol" && n.label === "deposit()");
    assert.equal(deposit.member_of, "Vault");
    assert.equal(deposit.symbol_kind, "method");
    assert.equal(deposit.visibility, "public");
    assert.equal(deposit.parameter_count, 1);
    const ctor = g.nodes.find((n) => n.source_file === "src/Vault.sol" && n.symbol_kind === "constructor");
    assert.ok(ctor, "constructor extracted");
    assert.equal(ctor.member_of, "Vault");

    const ep = (v) => String(v && typeof v === "object" ? v.id : v);
    const edge = (relation, srcName, tgtName) => g.links.find((l) => l.relation === relation
      && ep(l.source).includes("#" + srcName + "@") && ep(l.target).includes("#" + tgtName + "@"));
    assert.ok(edge("inherits", "Vault", "Base"), "Vault inherits Base via same-dir plain import");
    assert.ok(edge("inherits", "Vault", "IToken"), "Vault inherits IToken via named cross-dir import");
    assert.ok(edge("calls", "deposit", "onlyPositive"), "modifier invocation is a call edge");
    assert.ok(edge("calls", "deposit", "Deposited"), "emit resolves to the inherited event");
    assert.ok(g.links.some((l) => l.relation === "contains" && ep(l.source).includes("#Vault@") && ep(l.target).includes("#deposit@")), "contract contains its method");

    const fileImport = (target) => g.links.some((l) => l.relation === "imports" && ep(l.source) === "src/Vault.sol" && ep(l.target) === target);
    assert.ok(fileImport("src/Base.sol"), "relative plain import edge");
    assert.ok(fileImport("src/interfaces/IToken.sol"), "relative named import edge");
    assert.ok(fileImport("shared-sol/Math.sol"), "remappings.txt-resolved import edge");

    const oz = (g.externalImports || []).find((r) => r.file === "src/Vault.sol" && r.pkg === "@openzeppelin/contracts");
    assert.ok(oz, "npm-style Solidity import recorded as external dependency");
    assert.equal(oz.kind, "sol-import");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
