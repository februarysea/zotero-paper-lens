const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const addon = path.resolve(__dirname, '../addon');
function visit(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    const full = path.join(dir,item.name);
    if (item.isDirectory()) visit(full);
    else if (item.name.endsWith('.js')) execFileSync(process.execPath, ['--check',full], {stdio:'inherit'});
  }
}
visit(addon);
const manifest = JSON.parse(fs.readFileSync(path.join(addon,'manifest.json'),'utf8'));
const packageInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
if (!manifest.applications.zotero.id || !manifest.applications.zotero.update_url || manifest.version !== packageInfo.version) throw Error('Invalid manifest');
const root = path.resolve(__dirname, '..');
const repository = 'februarysea/zotero-paper-lens';
const homepage = `https://github.com/${repository}`;
const pluginID = 'paper-lens@februarysea.github.io';
const channel = packageInfo.paperLens?.releaseChannel;
if (!['beta', 'stable'].includes(channel)) throw Error('Invalid release channel');
const updateFilename = channel === 'beta' ? 'updates-beta.json' : 'updates.json';
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
    || manifest.author !== 'februarysea' || packageInfo.author !== 'februarysea'
    || manifest.homepage_url !== homepage || packageInfo.homepage !== homepage
    || packageInfo.repository?.url !== `git+${homepage}.git`
    || manifest.applications.zotero.id !== pluginID
    || manifest.applications.zotero.update_url !== `https://raw.githubusercontent.com/${repository}/main/${updateFilename}`) {
  throw Error('Invalid public release identity');
}
if (!fs.existsSync(path.join(root, 'docs/releases', `v${manifest.version}.md`))) throw Error('Missing release notes');
for (const filename of ['updates-beta.json', 'updates.json']) {
  const updates = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
  if (Object.keys(updates.addons || {}).join() !== pluginID || !Array.isArray(updates.addons[pluginID].updates)) {
    throw Error(`Invalid update manifest: ${filename}`);
  }
  const versions = new Set();
  for (const update of updates.addons[pluginID].updates) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(update.version)
        || versions.has(update.version)
        || update.update_link !== `${homepage}/releases/download/v${update.version}/paper-lens-${update.version}.xpi`
        || !/^sha256:[a-f0-9]{64}$/.test(update.update_hash)
        || !update.applications?.zotero?.strict_min_version || !update.applications?.zotero?.strict_max_version) {
      throw Error(`Invalid update entry in ${filename}`);
    }
    versions.add(update.version);
  }
}
const manifestLocaleRoot = path.join(addon, '_locales');
if (!manifest.default_locale || !fs.existsSync(path.join(manifestLocaleRoot, manifest.default_locale, 'messages.json'))) {
  throw Error('Missing default manifest locale');
}
for (const locale of fs.readdirSync(manifestLocaleRoot)) {
  const messages = JSON.parse(fs.readFileSync(path.join(manifestLocaleRoot, locale, 'messages.json'), 'utf8'));
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    if (!messages[key]?.message) throw Error(`Missing manifest message ${locale}/${key}`);
  }
}

// Fluent message values replace an element's text content. A collapsible-section
// already contains its header and body, so its localization must set .label only.
// Sidenav localization similarly belongs on .tooltiptext, preserving its icon.
const mainSource = fs.readFileSync(path.join(addon, 'content/main.js'), 'utf8');
const structuralLabels = Array.from(mainSource.matchAll(/\b(header|sidenav)\s*:\s*\{\s*l10nID\s*:\s*["']([^"']+)["']/g))
  .map((match) => ({ id: match[2], attribute: match[1] === 'header' ? 'label' : 'tooltiptext' }));
if (!structuralLabels.some((label) => label.attribute === 'label')
    || !structuralLabels.some((label) => label.attribute === 'tooltiptext')) {
  throw Error('Unable to verify custom section localization identifiers');
}
function messagesFor(source) {
  const messages = new Map();
  let current = null;
  let inAttribute = false;
  for (const line of source.split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*=(.*)$/.exec(line);
    if (entry) {
      current = { value: entry[2].trim(), attributes: new Set() };
      messages.set(entry[1], current);
      inAttribute = false;
      continue;
    }
    if (!current || !line.trim() || /^\s*#/.test(line)) continue;
    const attribute = /^\s+\.([A-Za-z][A-Za-z0-9_-]*)\s*=/.exec(line);
    if (attribute) {
      current.attributes.add(attribute[1]);
      inAttribute = true;
    } else if (/^\s+\S/.test(line) && !inAttribute) {
      current.value += line.trim();
    } else if (/^\S/.test(line)) {
      current = null;
    }
  }
  return messages;
}
let referenceIDs;
const preferenceSource = fs.readFileSync(path.join(addon, 'content/preferences.xhtml'), 'utf8');
const preferenceIDs = [...preferenceSource.matchAll(/data-l10n-id="([^"]+)"/g)].map((match) => match[1]);
for (const locale of fs.readdirSync(path.join(addon, 'locale'))) {
  const file = path.join(addon, 'locale', locale, 'paper-lens.ftl');
  const messages = messagesFor(fs.readFileSync(file, 'utf8'));
  const ids = [...messages.keys()].sort();
  if (referenceIDs && JSON.stringify(ids) !== JSON.stringify(referenceIDs)) {
    throw Error(`${file}: Fluent identifiers do not match the other locale`);
  }
  referenceIDs = ids;
  for (const id of preferenceIDs) {
    if (!messages.has(id)) throw Error(`${file}: missing settings localization ${id}`);
  }
  for (const label of structuralLabels) {
    const message = messages.get(label.id);
    if (!message || message.value || !message.attributes.has(label.attribute)) {
      throw Error(`${file}: ${label.id} must have .${label.attribute} and no message value; a value would overwrite the section DOM`);
    }
  }
}
console.log('JavaScript syntax, release identity, update manifests, and structural Fluent localization passed.');
