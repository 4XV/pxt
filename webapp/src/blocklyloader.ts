/// <reference path="./blockly.d.ts" />

import * as compiler from "./compiler"

var blockColors: Util.StringMap<number> = {
    basic: 190,
    led: 3,
    input: 300,
    loops: 120,
    pins: 351,
    music: 52,
    game: 176,
    images: 45,
    variables: 330,
    devices: 156,
    radio: 270,
}

// list of built-in blocks, should be touched.
var builtinBlocks: Util.StringMap<any> = {};
Object.keys(Blockly.Blocks).forEach(k => builtinBlocks[k] = Blockly.Blocks[k]);

// blocks cached
interface CachedBlock {
    hash: string;
    fn: ts.mbit.SymbolInfo;
    block: {
        init: () => void;
    };
}
var cachedBlocks: Util.StringMap<CachedBlock> = {};
var cachedToolbox: string = "";

function createShadowValue(name: string, num: boolean, v: string): Element {
    var value = document.createElement("value");
    value.setAttribute("name", name);
    var shadow = document.createElement("shadow"); value.appendChild(shadow);
    shadow.setAttribute("type", num ? "math_number" : "text");
    var field = document.createElement("field"); shadow.appendChild(field);
    field.setAttribute("name", num ? "NUM" : "TEXT");
    field.innerText = v || "";

    return value;
}

export function parameterNames(fn: ts.mbit.SymbolInfo): Util.StringMap<string> {
    // collect blockly parameter name mapping
    let attrNames: Util.StringMap<string> = {};
    fn.parameters.forEach(pr => attrNames[pr.name] = pr.name);
    if (fn.attributes.block) {
        Object.keys(attrNames).forEach(k => attrNames[k] = "");
        let rx = /%[a-zA-Z0-9]+/g;
        let m : RegExpExecArray;
        let i = 0;
        while(m = rx.exec(fn.attributes.block)) {
            attrNames[fn.parameters[i++].name] = m[0].slice(1);
        }
    }
    return attrNames;
}

function injectToolbox(tb: Element, fn: ts.mbit.SymbolInfo, attrNames: Util.StringMap<string>) {
    //
    // toolbox update
    //
    var block = document.createElement("block");
    block.setAttribute("type", fn.attributes.blockId);
    if (fn.attributes.blockGap)
        block.setAttribute("gap", fn.attributes.blockGap);

    fn.parameters.filter(pr => !!attrNames[pr.name]).forEach(pr => {
        if (pr.type == "number")
            block.appendChild(createShadowValue(attrNames[pr.name], true, pr.defaults ? pr.defaults[0] : "0"));
        else if (pr.type == "string")
            block.appendChild(createShadowValue(attrNames[pr.name], false, pr.defaults ? pr.defaults[0] : ""));
    })

    var catName = fn.namespace[0].toUpperCase() + fn.namespace.slice(1);
    var category = tb.querySelector("category[name~='" + catName + "']");
    if (!category) {
        console.log('toolbox: adding category ' + fn.namespace)
        category = document.createElement("category");
        category.setAttribute("name", catName)
        tb.appendChild(category);
    }
    category.appendChild(block);
}

var iconCanvasCache: Util.StringMap<HTMLCanvasElement> = {};
function iconToFieldImage(c: string): Blockly.FieldImage {
    let canvas = iconCanvasCache[c];
    if (!canvas) {
        canvas = iconCanvasCache[c] = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.font = "56px Icons";
        ctx.textAlign = "center";
        ctx.fillText(c, canvas.width / 2, 56);
    }
    return new Blockly.FieldImage(canvas.toDataURL(), 16, 16, '');
}

function injectBlockDefinition(info: BlocksInfo, fn: ts.mbit.SymbolInfo, attrNames: Util.StringMap<string>): boolean {
    let id = fn.attributes.blockId;

    if (builtinBlocks[id]) {
        console.error('trying to override builtin block ' + id);
        return false;
    }

    let hash = JSON.stringify(fn);
    if (cachedBlocks[id] && cachedBlocks[id].hash == hash) {
        console.log('block already in toolbox: ' + id);
        return true;
    }

    if (Blockly.Blocks[fn.attributes.blockId]) {
        console.error("duplicate block definition: " + id);
        return false;
    }

    var cachedBlock: CachedBlock = {
        hash: hash,
        fn: fn,
        block: {
            init: function() { initBlock(this, info, fn, attrNames) }
        }
    }

    cachedBlocks[id] = cachedBlock;
    Blockly.Blocks[id] = cachedBlock.block;

    return true;
}

function initBlock(block:any, info: BlocksInfo, fn: ts.mbit.SymbolInfo, attrNames: Util.StringMap<string>) {
    block.setHelpUrl("./" + fn.attributes.help);
    block.setColour(blockColors[fn.namespace] || 255);

    fn.attributes.block.split('|').map((n, ni) => {
        let m = /([^%]*)%([a-zA-Z0-0]+)/.exec(n);
        if (!m) {
            let i = block.appendDummyInput();
            if (ni == 0 && fn.attributes.icon) i.appendField(iconToFieldImage(fn.attributes.icon))
            i.appendField(n);
        } else {
            // find argument
            let pre = m[1]; 
            let p = m[2];
            let n = Object.keys(attrNames).filter(k => attrNames[k] == p)[0];
            if (!n) {
                console.error("block " + fn.attributes.blockId + ": unkown parameter " + p);
                return;
            }

            let pr = fn.parameters.filter(p => p.name == n)[0];
            if (pr.type == "number") {
                let i = block.appendValueInput(p)
                    .setAlign(Blockly.ALIGN_RIGHT)
                    .setCheck("Number");
                if (pre) i.appendField(pre);
            }
            else if (pr.type == "boolean") {
                let i = block.appendValueInput(p)
                    .setCheck("Boolean");
                if (pre) i.appendField(pre);
            } else if (pr.type == "string") {
                let i = block.appendValueInput(p)
                    .setAlign(Blockly.ALIGN_RIGHT)
                    .setCheck("String");
                if (pre) i.appendField(pre);
            } else {
                let prtype = Util.lookup(info.apis.byQName, pr.type);
                if (prtype && prtype.kind == ts.mbit.SymbolKind.Enum) {
                    let dd = Util.values(info.apis.byQName)
                        .filter(e => e.namespace == pr.type)
                        .map(v => [v.attributes.blockId || v.name, v.namespace + "." + v.name]);
                    let i = block.appendDummyInput()
                        .appendField(new Blockly.FieldDropdown(dd), "NAME");
                    if (pre) i.appendField(pre);
                }
            }
        }
    });

    let body = fn.parameters.filter(pr => pr.type == "() => void")[0];
    if (body) {
        block.appendStatementInput(attrNames[body.name] || "HANDLER")
            .setCheck("null");
    }

    if (fn.attributes.imageLiteral) {
        for (let r = 0; r < 5; ++r) {
            let ri = block.appendDummyInput();
            for (let c = 0; c < 5; ++c) {
                if (c > 0) ri.appendField(" ");
                ri.appendField(new Blockly.FieldCheckbox("FALSE"), "LED" + r + c);
            }
        }
    }

    block.setInputsInline(!fn.attributes.blockExternalInputs && fn.parameters.length < 4 && !fn.attributes.imageLiteral);

    switch (fn.retType) {
        case "number": block.setOutput(true, "Number"); break;
        case "string": block.setOutput(true, "String"); break;
        case "boolean": block.setOutput(true, "Boolean"); break;
        case "void": break; // do nothing
        //TODO
        default: block.setOutput(true);
    }

    if (!/^on /.test(fn.attributes.block)) {
        block.setPreviousStatement(fn.retType == "void");
        block.setNextStatement(fn.retType == "void");
    }
    block.setTooltip(fn.attributes.jsDoc);
}

export function injectBlocks(workspace: Blockly.Workspace, toolbox: Element, blockInfo: BlocksInfo): void {

    blockInfo.blocks.sort((f1, f2) => {
        return (f2.attributes.weight || 50) - (f1.attributes.weight || 50);
    })

    let currentBlocks: Util.StringMap<number> = {};

    // create new toolbox and update block definitions
    let tb = <Element>toolbox.cloneNode(true);
    blockInfo.blocks
        .filter(fn => !tb.querySelector("block[type='" + fn.attributes.blockId + "']"))
        .forEach(fn => {
            let pnames = parameterNames(fn);
            if (injectBlockDefinition(blockInfo, fn, pnames)) {
                injectToolbox(tb, fn, pnames);
                currentBlocks[fn.attributes.blockId] = 1;
            }
        })

    // remove ununsed blocks
    Object
        .keys(cachedBlocks).filter(k => !currentBlocks[k])
        .forEach(k => removeBlock(cachedBlocks[k].fn));

    // update toolbox   
    if (tb.innerHTML != cachedToolbox) {
        cachedToolbox = tb.innerHTML;
        workspace.updateToolbox(tb)
    }
}

function removeBlock(fn: ts.mbit.SymbolInfo) {
    delete Blockly.Blocks[fn.attributes.blockId];
    delete cachedBlocks[fn.attributes.blockId];
}

export interface BlocksInfo {
    apis: ts.mbit.ApisInfo;
    blocks: ts.mbit.SymbolInfo[];
}

export function getBlocksAsync(): Promise<BlocksInfo> {
    return compiler.getApisInfoAsync()
        .then(info => {
            return {
                apis: info,
                blocks: Util.values(info.byQName).filter(s => !!s.attributes.block && !!s.attributes.blockId)
            }
        })
}
