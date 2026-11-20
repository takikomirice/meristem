import { observeParent } from './pre-p6-observation.js';

// Passive readback of an already running test window. This probe never opens a chat.
const [configFile, expectedThread] = process.argv.slice(2);
console.log(JSON.stringify(await observeParent('vscode', configFile, expectedThread), null, 2));
