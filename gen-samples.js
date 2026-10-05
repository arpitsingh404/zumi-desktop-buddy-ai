/* Writes a tiny "hello from Zumi" program in MANY languages into
 * %USERPROFILE%\ZumiWorkspace\samples\<lang>\  (and lists them).
 * Nothing is deleted.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const OUT = path.join(os.homedir(), "ZumiWorkspace", "samples");

const S = {
  python: ["py", `# Zumi says hi\nname = "Zumi"\nprint(f"Hi from {name}! 🐾")\nfor i in range(3):\n    print("count", i)\n`],
  javascript: ["js", `// Zumi says hi\nconst name = "Zumi";\nconsole.log(\`Hi from \${name}! 🐾\`);\n[0,1,2].forEach(i => console.log("count", i));\n`],
  typescript: ["ts", `// Zumi says hi\nconst name: string = "Zumi";\nconsole.log(\`Hi from \${name}! 🐾\`);\n`],
  java: ["java", `// Zumi says hi\npublic class Main {\n  public static void main(String[] a) {\n    String name = "Zumi";\n    System.out.println("Hi from " + name + "! 🐾");\n  }\n}\n`],
  c: ["c", `/* Zumi says hi */\n#include <stdio.h>\nint main(){ printf("Hi from Zumi! 🐾\\n"); return 0; }\n`],
  cpp: ["cpp", `// Zumi says hi\n#include <iostream>\nint main(){ std::cout << "Hi from Zumi! 🐾\\n"; return 0; }\n`],
  csharp: ["cs", `// Zumi says hi\nusing System;\nclass P { static void Main(){ Console.WriteLine("Hi from Zumi! 🐾"); } }\n`],
  go: ["go", `// Zumi says hi\npackage main\nimport "fmt"\nfunc main(){ fmt.Println("Hi from Zumi! 🐾") }\n`],
  rust: ["rs", `// Zumi says hi\nfn main(){ println!("Hi from Zumi! 🐾"); }\n`],
  php: ["php", `<?php\n// Zumi says hi\necho "Hi from Zumi! 🐾\\n";\n`],
  ruby: ["rb", `# Zumi says hi\nputs "Hi from Zumi! 🐾"\n3.times { |i| puts "count #{i}" }\n`],
  swift: ["swift", `// Zumi says hi\nprint("Hi from Zumi! 🐾")\n`],
  kotlin: ["kt", `// Zumi says hi\nfun main(){ println("Hi from Zumi! 🐾") }\n`],
  scala: ["scala", `// Zumi says hi\nobject Main extends App { println("Hi from Zumi! 🐾") }\n`],
  r: ["R", `# Zumi says hi\ncat("Hi from Zumi! 🐾\\n")\nprint(1:3)\n`],
  matlab: ["m", `% Zumi says hi\ndisp('Hi from Zumi!')\n`],
  perl: ["pl", `# Zumi says hi\nprint "Hi from Zumi! 🐾\\n";\n`],
  lua: ["lua", `-- Zumi says hi\nprint("Hi from Zumi! 🐾")\n`],
  dart: ["dart", `// Zumi says hi\nvoid main(){ print('Hi from Zumi! 🐾'); }\n`],
  elixir: ["ex", `# Zumi says hi\nIO.puts("Hi from Zumi! 🐾")\n`],
  haskell: ["hs", `-- Zumi says hi\nmain = putStrLn "Hi from Zumi! 🐾"\n`],
  sql: ["sql", `-- Zumi says hi\nSELECT 'Hi from Zumi! 🐾' AS greeting;\n`],
  bash: ["sh", `#!/usr/bin/env bash\n# Zumi says hi\necho "Hi from Zumi! 🐾"\n`],
  powershell: ["ps1", `# Zumi says hi\nWrite-Output "Hi from Zumi! 🐾"\n`],
  html: ["html", `<!doctype html>\n<!-- Zumi says hi -->\n<h1>Hi from Zumi! 🐾</h1>\n`],
  css: ["css", `/* Zumi says hi */\nbody::after { content: "Hi from Zumi! 🐾"; }\n`],
  sass: ["scss", `// Zumi says hi\n$c: #5ad6b0;\nbody { color: $c; }\n`],
  json: ["json", `{ "name": "Zumi", "kind": "desktop buddy", "hello": "Hi from Zumi! 🐾" }\n`],
  yaml: ["yaml", `# Zumi says hi\nname: Zumi\nhello: "Hi from Zumi! 🐾"\n`],
  xml: ["xml", `<?xml version="1.0"?>\n<!-- Zumi says hi -->\n<zumi><hello>Hi from Zumi!</hello></zumi>\n`],
  markdown: ["md", `# Zumi says hi 🐾\n\n**Zumi** is a desktop buddy and autonomous PC agent.\n`],
  assembly: ["asm", `; Zumi says hi (x86-64, illustrative)\nsection .data\nmsg db "Hi from Zumi!",0\n`],
  solidity: ["sol", `// SPDX-License-Identifier: MIT\n// Zumi says hi\npragma solidity ^0.8.0;\ncontract Zumi { string public hello = "Hi from Zumi! 🐾"; }\n`],
  julia: ["jl", `# Zumi says hi\nprintln("Hi from Zumi! 🐾")\n`],
  fortran: ["f90", `! Zumi says hi\nprogram zumi\n  print *, "Hi from Zumi! 🐾"\nend program zumi\n`],
  vbnet: ["vb", `' Zumi says hi\nModule P\n  Sub Main()\n    Console.WriteLine("Hi from Zumi! 🐾")\n  End Sub\nEnd Module\n`],
  groovy: ["groovy", `// Zumi says hi\nprintln "Hi from Zumi! 🐾"\n`],
  objectivec: ["m", `// Zumi says hi\n#import <Foundation/Foundation.h>\nint main(){ NSLog(@"Hi from Zumi! 🐾"); return 0; }\n`],
  clojure: ["clj", `; Zumi says hi\n(println "Hi from Zumi! 🐾")\n`],
  erlang: ["erl", `% Zumi says hi\n-module(zumi).\n-export([main/0]).\nmain() -> io:format("Hi from Zumi! 🐾~n").\n`],
  zig: ["zig", `// Zumi says hi\nconst std = @import("std");\npub fn main() void { std.debug.print("Hi from Zumi! 🐾\\n", .{}); }\n`],
  nim: ["nim", `# Zumi says hi\necho "Hi from Zumi! 🐾"\n`],
  crystal: ["cr", `# Zumi says hi\nputs "Hi from Zumi! 🐾"\n`],
  ocaml: ["ml", `(* Zumi says hi *)\nprint_endline "Hi from Zumi! 🐾"\n`],
  fsharp: ["fs", `// Zumi says hi\nprintfn "Hi from Zumi! 🐾"\n`],
  cobol: ["cob", `      * Zumi says hi\n       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ZUMI.\n`],
  pascal: ["pas", `{ Zumi says hi }\nprogram Zumi;\nbegin\n  writeln('Hi from Zumi!');\nend.\n`],
  tcl: ["tcl", `# Zumi says hi\nputs "Hi from Zumi! 🐾"\n`],
  awk: ["awk", `# Zumi says hi\nBEGIN { print "Hi from Zumi! 🐾" }\n`],
};

fs.mkdirSync(OUT, { recursive: true });
const written = [];
for (const [lang, [ext, code]] of Object.entries(S)) {
  const dir = path.join(OUT, lang);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "hello." + ext);
  fs.writeFileSync(file, code);
  written.push({ lang, file, bytes: code.length });
}
const index = ["# Zumi — code samples in many languages", "", `Total: ${written.length} languages`, ""].concat(written.map((w) => `- **${w.lang}** → \`${path.relative(path.join(os.homedir(), "ZumiWorkspace"), w.file)}\``));
fs.writeFileSync(path.join(OUT, "INDEX.md"), index.join("\n"));
console.log(`wrote ${written.length} languages to ${OUT}`);
console.log("languages: " + written.map((w) => w.lang).join(", "));
