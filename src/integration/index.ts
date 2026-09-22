// The extension host requires this module and calls run().
import * as fs from "fs";
import * as path from "path";
import Mocha = require("mocha");   // `import Mocha from` needs esModuleInterop at runtime; this does not

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60000 });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith(".itest.js")) {
      mocha.addFile(path.join(__dirname, file));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} failing`)) : resolve()));
  });
}
