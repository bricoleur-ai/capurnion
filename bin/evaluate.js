#!/usr/bin/env node
/* Reads {"rules":[...],"ctx":{host,url,pageText}} on stdin, prints the matcher's
   verdict per rule as JSON. `capurnion test` calls this so the CLI and the
   extension never disagree about what would fire. */
const path = require("path");
const matcher = require(path.join(__dirname, "..", "matcher.js"));
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const { rules, ctx } = JSON.parse(raw);
  const out = rules
    .filter((r) => matcher.hostListed(r, ctx.host))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: (r.click || {}).label || "",
      blocked: matcher.blockers(r, ctx),
    }));
  process.stdout.write(JSON.stringify(out));
});
