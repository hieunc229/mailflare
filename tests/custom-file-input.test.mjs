import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "tests", ".tmp-file-input-"));
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://mail.example/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "Event", "KeyboardEvent", "MutationObserver"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await build({ stdin: { contents: `import React,{act} from 'react'; import {createRoot} from 'react-dom/client'; import {Input} from './src/components/ui/input'; export {React,act,createRoot,Input};`, loader: "tsx", resolveDir: root }, outfile: join(dir, "ui.mjs"), bundle: true, platform: "browser", format: "esm", external: ["react", "react-dom", "react-dom/client"], alias: { "@": join(root, "src") }, logLevel: "silent" });
const {React,act,createRoot,Input}=await import(pathToFileURL(join(dir,"ui.mjs")).href);
test("custom file picker keeps native selection, callback, label and reset", async () => {
	const container=document.createElement("div");document.body.append(container);
	const reactRoot=createRoot(container);const ref=React.createRef();let selected;
	await act(async()=>reactRoot.render(React.createElement("form",null,React.createElement("label",null,"Backup file",React.createElement(Input,{id:"files",type:"file",multiple:true,ref,required:true,"aria-describedby":"file-help","aria-errormessage":"file-error","aria-invalid":true,onChange:e=>{selected=e.target.files;}})),React.createElement("p",{id:"file-help"},"EML files only"),React.createElement("p",{id:"file-error"},"Choose a backup file"))));
	const native=container.querySelector("input");const button=container.querySelector("button");const description=container.querySelector("span[id]");assert.equal(ref.current,native);assert.ok(button);assert.equal(native.className,"sr-only");
	assert.equal(button.getAttribute("aria-label"),"Backup file");assert.equal(button.getAttribute("aria-controls"),"files");assert.equal(button.getAttribute("aria-invalid"),"true");assert.equal(button.getAttribute("aria-required"),"true");assert.equal(button.getAttribute("aria-errormessage"),"file-error");assert.equal(button.getAttribute("aria-describedby"),`file-help ${description.id}`);assert.equal(native.getAttribute("aria-describedby"),`file-help ${description.id}`);assert.equal(native.getAttribute("aria-errormessage"),"file-error");assert.equal(description.getAttribute("aria-live"),"polite");
	const file=new dom.window.File(["sample"],"sample.eml");Object.defineProperty(native,"files",{configurable:true,value:[file]});Object.defineProperty(native,"value",{configurable:true,value:"C:\\fakepath\\sample.eml"});
	await act(async()=>native.dispatchEvent(new Event("change",{bubbles:true})));assert.equal(selected[0],file);assert.ok(container.textContent.includes("sample.eml"));
	await act(async()=>container.querySelector("form").reset());assert.ok(!container.textContent.includes("sample.eml"));
	await act(async()=>reactRoot.render(React.createElement(Input,{id:"files",type:"file",ref,"aria-label":"Import archive","aria-required":true,"aria-invalid":true,"aria-errormessage":"file-error"})));
	assert.equal(container.querySelector("button").getAttribute("aria-label"),"Import archive");assert.equal(container.querySelector("input").getAttribute("aria-label"),"Import archive");assert.equal(container.querySelector("button").getAttribute("aria-required"),"true");assert.equal(container.querySelector("input").getAttribute("aria-required"),"true");assert.equal(container.querySelector("button").getAttribute("aria-errormessage"),"file-error");
	await act(async()=>reactRoot.unmount());container.remove();
});
test("number limits reject negative and exponent key input", async () => {
	const container=document.createElement("div");document.body.append(container);const reactRoot=createRoot(container);
	await act(async()=>reactRoot.render(React.createElement(Input,{type:"number",min:1})));
	const input=container.querySelector("input");for(const key of ["-","+","e","E"]){const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true});await act(async()=>input.dispatchEvent(event));assert.equal(event.defaultPrevented,true);}
	const digit=new KeyboardEvent("keydown",{key:"3",bubbles:true,cancelable:true});await act(async()=>input.dispatchEvent(digit));assert.equal(digit.defaultPrevented,false);
	await act(async()=>reactRoot.unmount());container.remove();rmSync(dir,{recursive:true,force:true});
});
