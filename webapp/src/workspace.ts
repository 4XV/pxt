/// <reference path="../../built/pxtlib.d.ts" />
/// <reference path="../../built/pxteditor.d.ts" />
/// <reference path="../../built/pxtwinrt.d.ts" />

import * as db from "./db";
import * as core from "./core";
import * as data from "./data";
import * as browserworkspace from "./browserworkspace"
import * as fileworkspace from "./fileworkspace"
import * as memoryworkspace from "./memoryworkspace"
import * as iframeworkspace from "./iframeworkspace"
import * as cloudsync from "./cloudsync"
import * as indexedDBWorkspace from "./idbworkspace";
import * as compiler from "./compiler"
import * as dialogs from "./dialogs"

import U = pxt.Util;
import Cloud = pxt.Cloud;

// Avoid importing entire crypto-js
/* tslint:disable:no-submodule-imports */
const sha1 = require("crypto-js/sha1");

type Header = pxt.workspace.Header;
type ScriptText = pxt.workspace.ScriptText;
type WorkspaceProvider = pxt.workspace.WorkspaceProvider;
type InstallHeader = pxt.workspace.InstallHeader;

interface HeaderWithScript {
    header: Header;
    text: ScriptText;
    version: pxt.workspace.Version;
}

let allScripts: HeaderWithScript[] = [];

let headerQ = new U.PromiseQueue();

let impl: WorkspaceProvider;
let implType: string;

function lookup(id: string) {
    return allScripts.filter(x => x.header.id == id || x.header.path == id)[0]
}

export function gitsha(data: string, encoding: "utf-8" | "base64" = "utf-8") {
    if (encoding == "base64") {
        const d = atob(data);
        return (sha1("blob " + d.length + "\u0000" + d) + "")
    } else
        return (sha1("blob " + U.toUTF8(data).length + "\u0000" + data) + "")
}

export function copyProjectToLegacyEditor(header: Header, majorVersion: number): Promise<Header> {
    if (!isBrowserWorkspace()) {
        return Promise.reject("Copy operation only works in browser workspace");
    }
    return browserworkspace.copyProjectToLegacyEditor(header, majorVersion);
}

export function setupWorkspace(id: string) {
    U.assert(!impl, "workspace set twice");
    pxt.log(`workspace: ${id}`);
    implType = id;
    switch (id) {
        case "fs":
        case "file":
            // Local file workspace, serializes data under target/projects/
            impl = fileworkspace.provider;
            break;
        case "mem":
        case "memory":
            impl = memoryworkspace.provider;
            break;
        case "iframe":
            // Iframe workspace, the editor relays sync messages back and forth when hosted in an iframe
            impl = iframeworkspace.provider;
            break;
        case "uwp":
            fileworkspace.setApiAsync(pxt.winrt.workspace.fileApiAsync);
            impl = pxt.winrt.workspace.getProvider(fileworkspace.provider);
            break;
        case "idb":
            impl = indexedDBWorkspace.provider;
            break;
        case "cloud":
        case "browser":
        default:
            impl = browserworkspace.provider
            break;
    }
}

export function getHeaders(withDeleted = false) {
    checkSession();
    let r = allScripts.map(e => e.header).filter(h => (withDeleted || !h.isDeleted) && !h.isBackup)
    r.sort((a, b) => b.recentUse - a.recentUse)
    return r
}

export function makeBackupAsync(h: Header, text: ScriptText): Promise<Header> {
    let h2 = U.flatClone(h)
    h2.id = U.guidGen()

    delete h2._rev
    delete (h2 as any)._id
    h2.isBackup = true;

    return importAsync(h2, text)
        .then(() => {
            h.backupRef = h2.id;
            return saveAsync(h2);
        })
        .then(() => h2)
}


export function restoreFromBackupAsync(h: Header) {
    if (!h.backupRef || h.isDeleted) return Promise.resolve();

    const refId = h.backupRef;
    return getTextAsync(refId)
        .then(files => {
            delete h.backupRef;
            return saveAsync(h, files);
        })
        .then(() => {
            const backup = getHeader(refId);
            backup.isDeleted = true;
            return saveAsync(backup);
        })
        .catch(() => {
            delete h.backupRef;
            return saveAsync(h);
        });
}

export function cleanupBackupsAsync() {
    checkSession();
    const allHeaders = allScripts.map(e => e.header);

    const refMap: pxt.Map<boolean> = {};

    // Figure out which scripts have backups
    allHeaders.filter(h => h.backupRef).forEach(h => refMap[h.backupRef] = true);

    // Delete the backups that don't have any scripts referencing them
    return Promise.all(allHeaders.filter(h => (h.isBackup && !refMap[h.id])).map(h => {
        h.isDeleted = true;
        return saveAsync(h);
    }));
}

export function getHeader(id: string) {
    checkSession();
    let e = lookup(id)
    if (e && !e.header.isDeleted)
        return e.header
    return null
}

let sessionID: string;
export function isSessionOutdated() {
    return pxt.storage.getLocal('pxt_workspace_session_id') != sessionID;
}
function checkSession() {
    if (isSessionOutdated()) {
        pxt.Util.assert(false, "trying to access outdated session")
    }
}

export function initAsync() {
    if (!impl) impl = browserworkspace.provider;

    // generate new workspace session id to avoid races with other tabs
    sessionID = ts.pxtc.Util.guidGen();
    pxt.storage.setLocal('pxt_workspace_session_id', sessionID);
    pxt.debug(`workspace session: ${sessionID}`);

    allScripts = []

    return syncAsync()
        .then(state => cleanupBackupsAsync().then(() => state))
        .then(_ => {
            pxt.perf.recordMilestone("workspace init finished")
            return _
        })
}

export function getTextAsync(id: string): Promise<ScriptText> {
    checkSession();

    let e = lookup(id)
    if (!e)
        return Promise.resolve(null as ScriptText)
    if (e.text)
        return Promise.resolve(e.text)
    return headerQ.enqueue(id, () => impl.getAsync(e.header)
        .then(resp => {
            if (!e.text) {
                // otherwise we were beaten to it
                e.text = fixupFileNames(resp.text);
            }
            e.version = resp.version;
            return e.text
        }))
}

export interface ScriptMeta {
    description: string;
    blocksWidth?: number;
    blocksHeight?: number;
}

// https://github.com/Microsoft/pxt-backend/blob/master/docs/sharing.md#anonymous-publishing
export function anonymousPublishAsync(h: Header, text: ScriptText, meta: ScriptMeta, screenshotUri?: string) {
    const saveId = {}
    h.saveId = saveId
    let thumbnailBuffer: string;
    let thumbnailMimeType: string;
    if (screenshotUri) {
        const m = /^data:(image\/(png|gif));base64,([a-zA-Z0-9+/]+=*)$/.exec(screenshotUri);
        if (m) {
            thumbnailBuffer = m[3];
            thumbnailMimeType = m[1];
        }
    }
    const stext = JSON.stringify(text, null, 2) + "\n"
    const scrReq = {
        name: h.name,
        target: h.target,
        targetVersion: h.targetVersion,
        description: meta.description || lf("Made with ❤️ in {0}.", pxt.appTarget.title || pxt.appTarget.name),
        editor: h.editor,
        text: text,
        meta: {
            versions: pxt.appTarget.versions,
            blocksHeight: meta.blocksHeight,
            blocksWidth: meta.blocksWidth
        },
        thumbnailBuffer,
        thumbnailMimeType
    }
    pxt.debug(`publishing script; ${stext.length} bytes`)
    return Cloud.privatePostAsync("scripts", scrReq, /* forceLiveEndpoint */ true)
        .then((inf: Cloud.JsonScript) => {
            if (inf.shortid) inf.id = inf.shortid;
            h.pubId = inf.shortid
            h.pubCurrent = h.saveId === saveId
            h.meta = inf.meta;
            pxt.debug(`published; id /${h.pubId}`)
            return saveAsync(h)
                .then(() => inf)
        })
}

function fixupVersionAsync(e: HeaderWithScript) {
    if (e.version !== undefined)
        return Promise.resolve()
    return impl.getAsync(e.header)
        .then(resp => {
            e.version = resp.version;
        })
}

export function saveAsync(h: Header, text?: ScriptText, isCloud?: boolean): Promise<void> {
    checkSession();
    U.assert(h.target == pxt.appTarget.id);

    if (h.temporary)
        return Promise.resolve()

    let e = lookup(h.id)
    //U.assert(e.header === h)

    if (!isCloud)
        h.recentUse = U.nowSeconds()

    if (text || h.isDeleted) {
        if (text)
            e.text = text
        if (!isCloud) {
            h.pubCurrent = false
            h.blobCurrent = false
            h.modificationTime = U.nowSeconds();
            h.targetVersion = h.targetVersion || "0.0.0";
        }
        h.saveId = null
        // update version on save
    }

    // perma-delete
    if (h.isDeleted && h.blobVersion == "DELETED") {
        let idx = allScripts.indexOf(e)
        U.assert(idx >= 0)
        allScripts.splice(idx, 1)
        return headerQ.enqueue(h.id, () =>
            fixupVersionAsync(e).then(() =>
                impl.deleteAsync ? impl.deleteAsync(h, e.version) : impl.setAsync(h, e.version, {})))
    }

    // check if we have dynamic boards, store board info for home page rendering
    if (text && pxt.appTarget.simulator && pxt.appTarget.simulator.dynamicBoardDefinition) {
        const pxtjson = pxt.Package.parseAndValidConfig(text[pxt.CONFIG_NAME]);
        if (pxtjson && pxtjson.dependencies)
            h.board = Object.keys(pxtjson.dependencies)
                .filter(p => !!pxt.bundledSvg(p))[0];
    }

    return headerQ.enqueue<void>(h.id, () =>
        fixupVersionAsync(e).then(() =>
            impl.setAsync(h, e.version, text ? e.text : null)
                .then(ver => {
                    if (text)
                        e.version = ver
                    if ((text && !isCloud) || h.isDeleted) {
                        h.pubCurrent = false
                        h.blobCurrent = false
                        h.saveId = null
                        data.invalidate("text:" + h.id)
                        data.invalidate("pkg-git-status:" + h.id)
                    }
                    data.invalidate("header:" + h.id)
                    data.invalidate("header:*")
                })))
}

function computePath(h: Header) {
    let path = h.name.replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/ /g, "-")
    if (!path)
        path = "Untitled"; // do not translate
    if (lookup(path)) {
        let n = 2
        while (lookup(path + "-" + n))
            n++;
        path += "-" + n
    }

    return path
}

export function importAsync(h: Header, text: ScriptText, isCloud = false) {
    h.path = computePath(h)
    const e: HeaderWithScript = {
        header: h,
        text: text,
        version: null
    }
    allScripts.push(e)
    return saveAsync(h, text, isCloud)
}

export function installAsync(h0: InstallHeader, text: ScriptText) {
    checkSession();
    U.assert(h0.target == pxt.appTarget.id);

    const h = <Header>h0
    h.id = ts.pxtc.Util.guidGen();
    h.recentUse = U.nowSeconds()
    h.modificationTime = h.recentUse;

    const cfg: pxt.PackageConfig = pxt.Package.parseAndValidConfig(text[pxt.CONFIG_NAME]);
    if (cfg && cfg.preferredEditor)
        h.editor = cfg.preferredEditor
    return importAsync(h, text)
        .then(() => h)
}

export function renameAsync(h: Header, newName: string) {
    checkSession();
    return cloudsync.renameAsync(h, newName);
}

export function duplicateAsync(h: Header, text: ScriptText, rename?: boolean): Promise<Header> {
    let e = lookup(h.id)
    U.assert(e.header === h)
    let h2 = U.flatClone(h)
    e.header = h2

    h.id = U.guidGen()
    if (rename) {
        h.name = createDuplicateName(h);
        let cfg = JSON.parse(text[pxt.CONFIG_NAME]) as pxt.PackageConfig
        cfg.name = h.name
        text[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }
    delete h._rev
    delete (h as any)._id
    return importAsync(h, text)
        .then(() => h)
}

export function createDuplicateName(h: Header) {
    let reducedName = h.name.indexOf("#") > -1 ?
        h.name.substring(0, h.name.lastIndexOf('#')).trim() : h.name;
    let names = U.toDictionary(allScripts.filter(e => !e.header.isDeleted), e => e.header.name)
    let n = 2
    while (names.hasOwnProperty(reducedName + " #" + n))
        n++
    return reducedName + " #" + n;
}

export function saveScreenshotAsync(h: Header, data: string, icon: string) {
    checkSession();
    return impl.saveScreenshotAsync
        ? impl.saveScreenshotAsync(h, data, icon)
        : Promise.resolve();
}

export function fixupFileNames(txt: ScriptText) {
    if (!txt) return txt;
    ["kind.json", "yelm.json"].forEach(oldName => {
        if (!txt[pxt.CONFIG_NAME] && txt[oldName]) {
            txt[pxt.CONFIG_NAME] = txt[oldName]
            delete txt[oldName]
        }
    })
    return txt
}


const scriptDlQ = new U.PromiseQueue();
const scripts = new db.Table("script"); // cache for published scripts
//let scriptCache:any = {}
export function getPublishedScriptAsync(id: string) {
    checkSession();
    //if (scriptCache.hasOwnProperty(id)) return Promise.resolve(scriptCache[id])
    if (pxt.github.isGithubId(id))
        id = pxt.github.normalizeRepoId(id)
    let eid = encodeURIComponent(id)
    return pxt.packagesConfigAsync()
        .then(config => scriptDlQ.enqueue(id, () => scripts.getAsync(eid)
            .then(v => v.files, e =>
                (pxt.github.isGithubId(id) ?
                    pxt.github.downloadPackageAsync(id, config).then(v => v.files) :
                    Cloud.downloadScriptFilesAsync(id))
                    .catch(core.handleNetworkError)
                    .then(files => scripts.setAsync({ id: eid, files: files })
                        .then(() => {
                            //return (scriptCache[id] = files)
                            return files
                        })))
            .then(fixupFileNames))
        );
}

export enum PullStatus {
    NoSourceControl,
    UpToDate,
    GotChanges,
    NeedsCommit,
    BranchNotFound
}

const GIT_JSON = pxt.github.GIT_JSON
type GitJson = pxt.github.GitJson

export async function hasPullAsync(hd: Header) {
    return (await pullAsync(hd, true)) == PullStatus.GotChanges
}

export async function pullAsync(hd: Header, checkOnly = false) {
    let files = await getTextAsync(hd.id)
    await recomputeHeaderFlagsAsync(hd, files)
    let gitjsontext = files[GIT_JSON]
    if (!gitjsontext)
        return PullStatus.NoSourceControl
    let gitjson = JSON.parse(gitjsontext) as GitJson
    let parsed = pxt.github.parseRepoId(gitjson.repo)
    const sha = await pxt.github.getRefAsync(parsed.fullName, parsed.tag)
    if  (!sha) {
        // 404: branch does not exist, repo is gone or no rights to access repo
        // try to get the list of heads to see if we can access the project
        const heads = await pxt.github.listRefsAsync(parsed.fullName, "heads");
        if (heads && heads.length)
            return PullStatus.BranchNotFound;
        else
            return PullStatus.NoSourceControl; // something is wrong
    } else if (sha == gitjson.commit.sha)
        return PullStatus.UpToDate
    if (checkOnly)
        return PullStatus.GotChanges
    try {
        await githubUpdateToAsync(hd, { repo: gitjson.repo, sha, files, tryDiff3: true })
        return PullStatus.GotChanges
    } catch (e) {
        if (e.isMergeError)
            return PullStatus.NeedsCommit
        else throw e
    }
}

export async function hasMergeConflictMarkers(hd: Header): Promise<boolean> {
    const files = await getTextAsync(hd.id)
    return !!Object.keys(files).find(k => pxt.github.hasMergeConflictMarker(files[k]));
}

export async function prAsync(hd: Header, commitId: string, msg: string) {
    let parsed = pxt.github.parseRepoId(hd.githubId)
    // merge conflict - create a Pull Request
    const branchName = await pxt.github.getNewBranchNameAsync(parsed.fullName, "merge-")
    await pxt.github.createNewBranchAsync(parsed.fullName, branchName, commitId)
    const url = await pxt.github.createPRFromBranchAsync(parsed.fullName, parsed.tag, branchName, msg)
    // force user back to master - we will instruct them to merge PR in github.com website
    // and sync here to get the changes
    let headCommit = await pxt.github.getRefAsync(parsed.fullName, parsed.tag)
    await githubUpdateToAsync(hd, {
        repo: hd.githubId,
        sha: headCommit,
        files: {}
    })
    return url
}

export function bumpedVersion(cfg: pxt.PackageConfig) {
    let v = pxt.semver.parse(cfg.version || "0.0.0")
    v.patch++
    return pxt.semver.stringify(v)
}

export async function bumpAsync(hd: Header, newVer = "") {
    let files = await getTextAsync(hd.id)
    let cfg = JSON.parse(files[pxt.CONFIG_NAME]) as pxt.PackageConfig
    cfg.version = newVer || bumpedVersion(cfg)
    files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    await saveAsync(hd, files)
    return await commitAsync(hd, {
        message: cfg.version,
        createTag: "v" + cfg.version
    })
}

export interface CommitOptions {
    message?: string;
    createTag?: string;
    filenamesToCommit?: string[];
    // render blocks to png
    blocksScreenshotAsync?: () => Promise<string>;
    // render blocks diff to png
    blocksDiffScreenshotAsync?: () => Promise<string>;
}

const BLOCKS_PREVIEW_PATH = ".makecode/blocks.png";
const BLOCKSDIFF_PREVIEW_PATH = ".makecode/blocksdiff.png";
export async function commitAsync(hd: Header, options: CommitOptions = {}) {
    await cloudsync.ensureGitHubTokenAsync();

    let files = await getTextAsync(hd.id)
    let gitjsontext = files[GIT_JSON]
    if (!gitjsontext)
        U.userError(lf("Not a git extension."))
    let gitjson = JSON.parse(gitjsontext) as GitJson
    let parsed = pxt.github.parseRepoId(gitjson.repo)
    let cfg = pxt.Package.parseAndValidConfig(files[pxt.CONFIG_NAME]);
    let treeUpdate: pxt.github.CreateTreeReq = {
        base_tree: gitjson.commit.tree.sha,
        tree: []
    }
    const filenames = options.filenamesToCommit || pxt.allPkgFiles(cfg)
    const ignoredFiles = [GIT_JSON, pxt.SIMSTATE_JSON, pxt.SERIAL_EDITOR_FILE];
    for (const path of filenames.filter(f => ignoredFiles.indexOf(f) < 0)) {
        const fileContent = files[path];
        await addToTree(path, fileContent);
    }

    if (treeUpdate.tree.length == 0)
        U.userError(lf("Nothing to commit!"))

    let blocksDiffSha: string;
    if (options
        && treeUpdate.tree.find(e => e.path == "main.blocks")) {
        if (options.blocksScreenshotAsync) {
            const png = await options.blocksScreenshotAsync();
            if (png)
                await addToTree(BLOCKS_PREVIEW_PATH, png);
        }
        if (options.blocksDiffScreenshotAsync) {
            const png = await options.blocksDiffScreenshotAsync();
            if (png)
                blocksDiffSha = await addToTree(BLOCKSDIFF_PREVIEW_PATH, png);
        }
    }

    let treeId = await pxt.github.createObjectAsync(parsed.fullName, "tree", treeUpdate)
    let commit: pxt.github.CreateCommitReq = {
        message: options.message || lf("Update {0}", treeUpdate.tree.map(e => e.path).filter(f => !/\.makecode\//.test(f)).join(", ")),
        parents: [gitjson.commit.sha],
        tree: treeId
    }
    let commitId = await pxt.github.createObjectAsync(parsed.fullName, "commit", commit)
    let ok = await pxt.github.fastForwardAsync(parsed.fullName, parsed.tag, commitId)
    let newCommit = commitId
    if (!ok)
        newCommit = await pxt.github.mergeAsync(parsed.fullName, parsed.tag, commitId)

    if (newCommit == null) {
        return commitId
    } else {
        // if we created a block preview, add as comment
        if (blocksDiffSha)
            await pxt.github.postCommitComment(
                parsed.fullName,
                commitId,
                `![${lf("Difference between blocks")}](https://raw.githubusercontent.com/${parsed.fullName}/${commitId}/${BLOCKSDIFF_PREVIEW_PATH})`);

        await githubUpdateToAsync(hd, {
            repo: gitjson.repo,
            sha: newCommit,
            files,
            saveTag: options.createTag
        })
        if (options.createTag)
            await pxt.github.createTagAsync(parsed.fullName, options.createTag, newCommit)
        return ""
    }

    async function addToTree(path: string, content: string): Promise<string> {
        const data = {
            content: content,
            encoding: "utf-8"
        } as pxt.github.CreateBlobReq;
        if (path == pxt.CONFIG_NAME)
            data.content = prepareConfigForGithub(data.content, !!options.createTag);
        const m = /^data:([^;]+);base64,/.exec(content);
        if (m) {
            data.encoding = "base64";
            data.content = content.substr(m[0].length);
        }
        const sha = gitsha(data.content, data.encoding)
        const ex = pxt.github.lookupFile(gitjson.commit, path)
        let res: string;
        if (!ex || ex.sha != sha) {
            // look for unfinished merges
            if (data.encoding == "utf-8" &&
                pxt.github.hasMergeConflictMarker(data.content))
                throw mergeConflictMarkerError();
            res = await pxt.github.createObjectAsync(parsed.fullName, "blob", data)
            if (data.encoding == "utf-8")
                U.assert(res == sha, `sha not matching ${res} != ${sha}`)
            treeUpdate.tree.push({
                "path": path,
                "mode": "100644",
                "type": "blob",
                "sha": res,
                "url": undefined
            })
        }
        return res;
    }
}

interface UpdateOptions {
    repo: string;
    sha: string;
    files: pxt.Map<string>;
    saveTag?: string;
    justJSON?: boolean;
    tryDiff3?: boolean;
}

function mergeError() {
    const e = new Error("Merge error");
    (e as any).isMergeError = true
    return e
}

function mergeConflictMarkerError() {
    const e = new Error("Merge conflict marker error");
    (e as any).isMergeConflictMarkerError = true
    return e
}

async function githubUpdateToAsync(hd: Header, options: UpdateOptions) {
    const { repo, sha, files, justJSON } = options
    const parsed = pxt.github.parseRepoId(repo)
    const commit = await pxt.github.getCommitAsync(parsed.fullName, sha)
    let gitjson: GitJson = JSON.parse(files[GIT_JSON] || "{}")

    if (!gitjson.commit) {
        gitjson = {
            repo: repo,
            commit: null
        }
    }

    const downloadedFiles: pxt.Map<boolean> = {}
    let conflicts = 0;
    let blocksNeedDecompilation = false;

    const downloadAsync = async (path: string) => {
        downloadedFiles[path] = true
        const treeEnt = pxt.github.lookupFile(commit, path)
        const oldEnt = pxt.github.lookupFile(gitjson.commit, path)
        const hasChanges = files[path] != null && (!oldEnt || oldEnt.blobContent != files[path])
        if (!treeEnt) {
            // file in pxt.json but not in git:
            // changes were merged from the cloud but not pushed yet
            if (options.tryDiff3 && hasChanges)
                return files[path];
            if (!justJSON)
                files[path] = ""
            return ""
        }
        let text = oldEnt ? oldEnt.blobContent : files[path]
        if (text != null && gitsha(text) == treeEnt.sha) {
            treeEnt.blobContent = text
            if (!options.tryDiff3 && !options.justJSON)
                files[path] = text
            return text
        }
        text = await pxt.github.downloadTextAsync(parsed.fullName, sha, path)
        treeEnt.blobContent = text
        if (gitsha(text) != treeEnt.sha)
            U.userError(lf("Corrupt SHA1 on download of '{0}'.", path))
        if (options.tryDiff3 && hasChanges) {
            if (path == pxt.CONFIG_NAME) {
                text = pxt.github.mergeDiff3Config(files[path], oldEnt.blobContent, treeEnt.blobContent);
                if (!text) // merge failed?
                    throw mergeError()
            } else if (/\.blocks$/.test(path)) {
                // blocks file, try merging the blocks or clear it so that ts merge picks it up
                const d3 = pxt.blocks.mergeXml(files[path], oldEnt.blobContent, treeEnt.blobContent);
                // if xml merge fails, leave an empty xml payload to force decompilation
                blocksNeedDecompilation = blocksNeedDecompilation || !d3;
                text = d3 || "";
            } else {
                const d3 = pxt.github.diff3(files[path], oldEnt.blobContent, treeEnt.blobContent, lf("local changes"), lf("remote changes (pulled from Github)"))
                if (!d3) // merge failed?
                    throw mergeError()
                conflicts += d3.numConflicts
                if (d3.numConflicts && !/\.ts$/.test(path)) // only allow conflict markers in typescript files
                    throw mergeError()
                text = d3.merged
            }
        }
        if (!justJSON)
            files[path] = text
        return text
    }

    // we need to keep the old cfg to maintain the github id -> local workspace id
    const oldCfg = pxt.Package.parseAndValidConfig(files[pxt.CONFIG_NAME])
    const cfgText = await downloadAsync(pxt.CONFIG_NAME)
    let cfg = pxt.Package.parseAndValidConfig(cfgText);
    // invalid cfg or no TypeScript files
    if (!cfg || !cfg.files.find(f => /\.ts$/.test(f))) {
        if (hd) // not importing
            U.userError(lf("Invalid pxt.json file."));
        pxt.log(`github: reconstructing pxt.json`)
        cfg = pxt.github.reconstructConfig(files, commit, pxt.appTarget.blocksprj || pxt.appTarget.tsprj);
        files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }
    // patch the github references back to local workspaces
    if (oldCfg) {
        let ghupdated = 0;
        Object.keys(cfg.dependencies)
            // find github references that are also in the original version
            .filter(k => /^github:/.test(cfg.dependencies[k]) && oldCfg.dependencies[k])
            .forEach(k => {
                const gid = pxt.github.parseRepoId(cfg.dependencies[k]);
                if (gid) {
                    const wks = oldCfg.dependencies[k];
                    cfg.dependencies[k] = wks;
                    ghupdated++;
                }
            })
        if (ghupdated)
            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }

    for (const fn of pxt.allPkgFiles(cfg).slice(1))
        await downloadAsync(fn)

    if (!cfg.name) {
        cfg.name = (parsed.project || parsed.fullName).replace(/[^\w\-]/g, "");
        if (!justJSON)
            files[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(cfg);
    }
    if (!justJSON) {
        // if any block needs decompilation, don't allow merge error markers
        if (blocksNeedDecompilation && conflicts)
            throw mergeError()
        for (let k of Object.keys(files)) {
            if (k[0] != "." && !downloadedFiles[k])
                delete files[k]
        }
    }

    commit.tag = options.saveTag
    gitjson.commit = commit
    files[GIT_JSON] = JSON.stringify(gitjson, null, 4)

    if (!hd) {
        hd = await installAsync({
            name: cfg.name,
            githubId: repo,
            pubId: "",
            pubCurrent: false,
            meta: {},
            editor: pxt.BLOCKS_PROJECT_NAME,
            target: pxt.appTarget.id,
            targetVersion: pxt.appTarget.versions.target,
        }, files)
    } else {
        hd.name = cfg.name
        await saveAsync(hd, files)
    }

    return hd
}

export async function exportToGithubAsync(hd: Header, repoid: string) {
    const parsed = pxt.github.parseRepoId(repoid);
    const pfiles = pxt.template.packageFiles(hd.name);
    await pxt.github.putFileAsync(parsed.fullName, ".gitignore", pfiles[".gitignore"]);
    const sha = await pxt.github.getRefAsync(parsed.fullName, parsed.tag)
    const commit = await pxt.github.getCommitAsync(parsed.fullName, sha)
    const files = await getTextAsync(hd.id)
    files[GIT_JSON] = JSON.stringify({
        repo: repoid,
        commit
    })
    await saveAsync(hd, files);
    await initializeGithubRepoAsync(hd, repoid, false);
    // race condition, don't pull right away
    // await pullAsync(hd);
}


// to be called after loading header in a editor
export async function recomputeHeaderFlagsAsync(h: Header, files: ScriptText) {
    h.githubCurrent = false

    const gitjson: GitJson = JSON.parse(files[GIT_JSON] || "{}")

    h.githubId = gitjson && gitjson.repo
    h.githubTag = gitjson && gitjson.commit && gitjson.commit.tag

    if (!h.githubId)
        return

    if (!gitjson.commit || !gitjson.commit.tree)
        return

    let isCurrent = true
    let needsBlobs = false
    for (let k of Object.keys(files)) {
        if (k == GIT_JSON || k == pxt.SIMSTATE_JSON || k == pxt.SERIAL_EDITOR_FILE)
            continue
        let treeEnt = pxt.github.lookupFile(gitjson.commit, k)
        if (!treeEnt || treeEnt.type != "blob") {
            isCurrent = false
            continue
        }
        if (treeEnt.blobContent == null)
            needsBlobs = true
        let content = files[k];
        if (k == pxt.CONFIG_NAME)
            content = prepareConfigForGithub(content);
        if (content && treeEnt.sha != gitsha(content)) {
            isCurrent = false
            continue
        }
    }

    h.githubCurrent = isCurrent

    // this happens for older projects
    if (needsBlobs)
        await githubUpdateToAsync(h, {
            repo: gitjson.repo,
            sha: gitjson.commit.sha,
            files,
            justJSON: true
        })

    if (gitjson.isFork == null) {
        const p = pxt.github.parseRepoId(gitjson.repo)
        const r = await pxt.github.repoAsync(p.fullName, null)
        gitjson.isFork = !!r.fork
        files[GIT_JSON] = JSON.stringify(gitjson, null, 4)
        await saveAsync(h, files)
    }
}

// replace all file|worspace references with github sha
// createTag: determine if tags need to be enforced
export function prepareConfigForGithub(content: string, createTag?: boolean): string {
    // replace workspace: references with resolve github sha/tags.
    const cfg = pxt.Package.parseAndValidConfig(content);
    if (!cfg) return content;

    // cleanup
    delete (<any>cfg).installedVersion // cleanup old pxt.json files
    delete cfg.additionalFilePath
    delete cfg.additionalFilePaths
    delete cfg.targetVersions;

    // add list of supported targets
    const supportedTargets = cfg.supportedTargets || [];
    if (supportedTargets.indexOf(pxt.appTarget.id) < 0) {
        supportedTargets.push(pxt.appTarget.id);
        supportedTargets.sort();
        cfg.supportedTargets = supportedTargets;
    }

    // patch dependencies
    const localDependencies = Object.keys(cfg.dependencies)
        .filter(d => /^(file|workspace):/.test(cfg.dependencies[d]));
    for (const d of localDependencies)
        resolveDependencyAsync(d);

    return pxt.Package.stringifyConfig(cfg);

    function resolveDependencyAsync(d: string) {
        const v = cfg.dependencies[d];
        const hid = v.substring(v.indexOf(':') + 1);
        const header = getHeader(hid);
        if (!header.githubId) {
            if (createTag)
                U.userError(lf("Dependency {0} is a local project.", d))
        } else {
            const gid = pxt.github.parseRepoId(header.githubId);
            if (createTag && !/^v\d+/.test(header.githubTag))
                U.userError(lf("You need to create a release for dependency {0}.", d))
            const tag = header.githubTag || gid.tag;
            cfg.dependencies[d] = `github:${gid.fullName}#${tag}`;
        }
    }
}

export async function initializeGithubRepoAsync(hd: Header, repoid: string, forceTemplateFiles: boolean) {
    await cloudsync.ensureGitHubTokenAsync();

    let parsed = pxt.github.parseRepoId(repoid)
    let name = parsed.fullName.replace(/.*\//, "")

    let currFiles = await getTextAsync(hd.id);

    const templateFiles = pxt.template.packageFiles(name);
    pxt.template.packageFilesFixup(templateFiles, {
        repo: parsed.fullName
    });

    if (forceTemplateFiles) {
        U.jsonMergeFrom(currFiles, templateFiles);
    } else {
        // special handling of broken/missing/corrupted pxt.json
        if (!pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]))
            delete currFiles[pxt.CONFIG_NAME];
        // special case override README.md if empty
        let templateREADME = templateFiles["README.md"];
        if (currFiles["README.md"] && currFiles["README.md"].trim())
            templateREADME = undefined;
        // current files override defaults
        U.jsonMergeFrom(templateFiles, currFiles);
        currFiles = templateFiles;

        if (templateREADME)
            currFiles["README.md"] = templateREADME;
    }

    // update config with files if needed
    const pxtjson = pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]);
    const files = pxtjson.files;
    // if no ts files, add existing ones
    if (!files.filter(f => /\.ts$/.test(f)).length) {
        // add files from the template
        Object.keys(currFiles)
            .filter(f => /\.(blocks|ts|py|asm|md)$/.test(f))
            .filter(f => f != pxt.CONFIG_NAME)
            .forEach(f => files.push(f));
    }
    // update test file if needed
    const testFiles = pxtjson.testFiles || (pxtjson.testFiles = []);
    if (currFiles["test.ts"] && testFiles.indexOf("test.ts") < 0) {
        testFiles.push("test.ts");
    }
    // save updated pxtjson
    currFiles[pxt.CONFIG_NAME] = pxt.Package.stringifyConfig(pxtjson);

    // save
    await saveAsync(hd, currFiles)
    await commitAsync(hd, {
        message: lf("Initial files for MakeCode project"),
        filenamesToCommit: Object.keys(currFiles)
    })

    // remove files not in the package (only in git)
    currFiles = await getTextAsync(hd.id)
    const allfiles = pxt.allPkgFiles(pxt.Package.parseAndValidConfig(currFiles[pxt.CONFIG_NAME]))
    const ignoredFiles = [GIT_JSON, pxt.SIMSTATE_JSON, pxt.SERIAL_EDITOR_FILE, pxt.CONFIG_NAME];
    Object.keys(currFiles)
        .filter(f => ignoredFiles.indexOf(f) < 0 && allfiles.indexOf(f) < 0)
        .forEach(f => delete currFiles[f]);

    await saveAsync(hd, currFiles)

    return hd
}

export async function importGithubAsync(id: string): Promise<Header> {
    const repoid = pxt.github.normalizeRepoId(id).replace(/^github:/, "")
    const parsed = pxt.github.parseRepoId(repoid)

    let sha = ""
    let isEmpty = false
    let forceTemplateFiles = false;
    try {
        sha = await pxt.github.getRefAsync(parsed.fullName, parsed.tag)
        // if the repo does not have a pxt.json file, treat as empty
        // (must be done before)
        const commit = await pxt.github.getCommitAsync(parsed.fullName, sha)
        if (!commit.tree.tree.find(f => f.path == pxt.CONFIG_NAME)) {
            pxt.log(`github: detected import non-makecode project`)
            if (pxt.shell.isReadOnly())
                U.userError(lf("This repository looks empty."));
            isEmpty = true; // needs initialization
            forceTemplateFiles = false;
            // ask user before modifying project
            const r = await core.confirmAsync({
                header: lf("Initialize repository for MakeCode?"),
                body: lf("We need to add a few files to your repository to make it work with MakeCode.")
                    + " "
                    + lf("Your existing files will not be modified."),
                agreeLbl: lf("Ok")
            })
            if (!r) return Promise.resolve(undefined);
        }
    } catch (e) {
        if (e.statusCode == 409) {
            // this means repo is completely empty;
            // put all default files in there
            pxt.log(`github: detected import empty project`)
            if (pxt.shell.isReadOnly())
                U.userError(lf("This repository looks empty."));
            await cloudsync.ensureGitHubTokenAsync();
            await pxt.github.putFileAsync(parsed.fullName, ".gitignore", "# Initial\n");
            isEmpty = true;
            forceTemplateFiles = true;
            sha = await pxt.github.getRefAsync(parsed.fullName, parsed.tag)
        }
        else if (e.statusCode == 404) {
            core.errorNotification(lf("Sorry, that repository looks invalid."));
            U.userError(lf("No such repository or branch."));
        }
    }

    const hd = await githubUpdateToAsync(null, {
        repo: repoid,
        sha,
        files: {}
    })
    if (hd && isEmpty)
        await initializeGithubRepoAsync(hd, repoid, forceTemplateFiles);
    return hd
}

export function downloadFilesByIdAsync(id: string): Promise<pxt.Map<string>> {
    return Cloud.privateGetAsync(id, /* forceLiveEndpoint */ true)
        .then((scr: Cloud.JsonScript) => getPublishedScriptAsync(scr.id));
}

export function installByIdAsync(id: string) {
    return Cloud.privateGetAsync(id, /* forceLiveEndpoint */ true)
        .then((scr: Cloud.JsonScript) =>
            getPublishedScriptAsync(scr.id)
                .then(files => installAsync(
                    {
                        name: scr.name,
                        pubId: id,
                        pubCurrent: true,
                        meta: scr.meta,
                        editor: scr.editor,
                        target: scr.target,
                        targetVersion: scr.targetVersion || (scr.meta && scr.meta.versions && scr.meta.versions.target)
                    }, files)))
}

export function saveToCloudAsync(h: Header) {
    checkSession();
    return cloudsync.saveToCloudAsync(h)
}

export function resetCloudAsync(): Promise<void> {
    checkSession();

    // remove all cloudsync or github repositories
    return cloudsync.resetAsync()
        .then(() => Promise.all(allScripts.map(e => e.header).filter(h => h.cloudSync || h.githubId).map(h => {
            // Remove cloud sync'ed project
            h.isDeleted = true;
            h.blobVersion = "DELETED";
            return saveAsync(h, null, true);
        }))).then(() => data.invalidate("header:*"));
}

export function syncAsync(): Promise<pxt.editor.EditorSyncState> {
    checkSession();

    return impl.listAsync()
        .catch((e) => {
            // There might be a problem with the native databases. Switch to memory for this session so the user can at
            // least use the editor.
            pxt.tickEvent("workspace.syncerror", { ws: implType });
            pxt.log("Workspace error, switching to memory workspace");
            impl = memoryworkspace.provider;
            return impl.listAsync();
        })
        .then(headers => {
            let existing = U.toDictionary(allScripts || [], h => h.header.id)
            allScripts = []
            for (let hd of headers) {
                let ex = existing[hd.id]
                if (ex) {
                    U.jsonCopyFrom(ex.header, hd)
                    //ex.text = null
                    //ex.version = null
                } else {
                    ex = {
                        header: hd,
                        text: undefined,
                        version: undefined,
                    }
                }
                allScripts.push(ex)
            }
            data.invalidate("header:")
            data.invalidate("text:")
            data.invalidate("pkg-git-status:")
            cloudsync.syncAsync().done() // sync in background
        })
        .then(() => impl.getSyncState ? impl.getSyncState() : null)
}

export function resetAsync() {
    checkSession();
    allScripts = []
    return impl.resetAsync()
        .then(cloudsync.resetAsync)
        .then(db.destroyAsync)
        .then(() => {
            pxt.storage.clearLocal();
            data.clearCache();
            // keep local token (localhost and electron) on reset
            if (Cloud.localToken)
                pxt.storage.setLocal("local_token", Cloud.localToken);
        })
}

export function loadedAsync() {
    checkSession();
    if (impl.loadedAsync)
        return impl.loadedAsync()
    return Promise.resolve()
}

export function saveAssetAsync(id: string, filename: string, data: Uint8Array): Promise<void> {
    if (impl.saveAssetAsync)
        return impl.saveAssetAsync(id, filename, data)
    else
        return Promise.reject(new Error(lf("Assets not supported here.")))
}

export function listAssetsAsync(id: string): Promise<pxt.workspace.Asset[]> {
    if (impl.listAssetsAsync)
        return impl.listAssetsAsync(id)
    return Promise.resolve([])
}

export function isBrowserWorkspace() {
    return impl === browserworkspace.provider;
}

export function fireEvent(ev: pxt.editor.events.Event) {
    if (impl.fireEvent)
        return impl.fireEvent(ev)
    // otherwise, NOP
}

/*
    header:<guid>   - one header
    header:*        - all headers
*/

data.mountVirtualApi("header", {
    getSync: p => {
        p = data.stripProtocol(p)
        if (p == "*") return getHeaders()
        return getHeader(p)
    },
})

/*
    headers:SEARCH   - search headers
*/

data.mountVirtualApi("headers", {
    getAsync: p => {
        p = data.stripProtocol(p)
        const headers = getHeaders()
        if (!p) return Promise.resolve(headers)
        return compiler.projectSearchAsync({ term: p, headers })
            .then((searchResults: pxtc.service.ProjectSearchInfo[]) => searchResults)
            .then(searchResults => {
                let searchResultsMap = U.toDictionary(searchResults || [], h => h.id)
                return headers.filter(h => searchResultsMap[h.id]);
            });
    },
    expirationTime: p => 5 * 1000,
    onInvalidated: () => {
        compiler.projectSearchClear();
    }
})

/*
    text:<guid>            - all files
    text:<guid>/<filename> - one file
*/
data.mountVirtualApi("text", {
    getAsync: p => {
        const m = /^[\w\-]+:([^\/]+)(\/(.*))?/.exec(p)
        return getTextAsync(m[1])
            .then(files => {
                if (m[3])
                    return files[m[3]]
                else return files;
            })
    },
})
