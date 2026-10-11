// Turns the failures in a node:test TAP file into GitHub ::error annotations.
// Job logs of this repository can only be downloaded by its admins, while
// annotations are public through the checks API: without this, a red CI run
// says nothing about which test failed.
//
//   node .github/scripts/tap-annotate.mjs <tap-file>

import fs from "node:fs";

const file = process.argv[2];
let lines;
try {
  lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
} catch (err) {
  console.log(`::error title=tap-annotate::cannot read ${file}: ${err.message}`);
  process.exit(0);
}

// Workflow commands treat %, CR and LF specially in the message part.
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escTitle = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

const failures = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const indent = m[1].length;
  const detail = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (/^\s*(not )?ok \d+ /.test(line) && line.search(/\S/) <= indent) break;
    detail.push(line.trim());
  }
  const block = detail.join("\n");
  // Parent tests fail too when a subtest fails; their block only says so.
  if (/failureType:\s*'?subtestsFailed/.test(block)) continue;
  const location = /location:\s*'?([^'\n]+)/.exec(block)?.[1] ?? "";
  const errorStart = detail.findIndex((l) => l.startsWith("error:"));
  const error = errorStart < 0 ? block : detail.slice(errorStart, errorStart + 12).join("\n");
  failures.push({ name: m[2].trim(), location, error });
}

for (const f of failures.slice(0, 20)) {
  console.log(`::error title=${escTitle(`FAIL ${f.name}`)}::${esc(`${f.error}${f.location ? `\nat ${f.location}` : ""}`.slice(0, 1500))}`);
}
if (failures.length > 20) console.log(`::error title=tap-annotate::${failures.length - 20} more failures not annotated`);
if (!failures.length) console.log("::notice title=tap-annotate::no 'not ok' entries found in the TAP output");
