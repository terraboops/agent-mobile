/**
 * manifest-facts — what the SHIPPED manifest says about the component device-verify starts.
 *
 * WHY. apk-installable proves the launch activity exists and is the one `am start -n` names. It
 * does not prove Android will let anything start it. An activity that is not exported refuses an
 * `am start` from adb with a SecurityException, the process never comes up, and the launch stage
 * reads "no process and no crash in logcat" — because the refusal is a failure of the START, not
 * of the app, so nothing of ours ever ran to crash. The one blind spot left in that stage.
 *
 * Since targetSdk 31 an activity with an intent-filter MUST declare android:exported explicitly
 * or the package fails to install at all — so the dangerous case is not a missing attribute, it
 * is `exported="false"`, which installs cleanly and refuses to launch.
 *
 * Read from the APK, not from android/app/src/main/AndroidManifest.xml. The source is one input
 * to a merge; what ships is the answer, and a library manifest can flip an attribute on the way
 * through.
 */

/**
 * Parse an `aapt2 dump xmltree` dump into the activity elements it declares.
 *
 * The format is indentation-based:
 *   E: activity (line=56)
 *     A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.x.Main" (Raw: "...")
 *     A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
 *       E: intent-filter (line=63)
 *
 * @returns {Array<{name: string|null, exported: boolean|null, launcher: boolean}>}
 */
export function parseActivities(xmltree) {
  const lines = String(xmltree || '').split('\n');
  const out = [];
  let cur = null;
  let depth = 0;
  const indentOf = (l) => l.length - l.trimStart().length;

  for (const line of lines) {
    const t = line.trim();
    const ind = indentOf(line);
    if (/^E: activity\b/.test(t)) {
      if (cur) out.push(cur);
      cur = { name: null, exported: null, launcher: false };
      depth = ind;
      continue;
    }
    if (!cur) continue;
    /* A sibling or shallower element ends this activity. */
    if (/^E: /.test(t) && ind <= depth) { out.push(cur); cur = null; continue; }

    /* The attribute's namespace is a URL, which contains colons — so the name is what
     * follows the LAST colon before the `(0x...)` id, not the first. A lazier pattern
     * matched nothing at all and every activity came back with null fields. */
    const attr = /^A: (?:.*:)?([\w-]+)\(0x[0-9a-fA-F]+\)=(.*)$/.exec(t)
              || /^A: (?:.*:)?([\w-]+)=(.*)$/.exec(t);
    if (attr) {
      const [, key, rawVal] = attr;
      const val = rawVal.replace(/\s*\(Raw:.*\)$/, '').replace(/^"|"$/g, '');
      if (key === 'name' && cur.name === null) cur.name = val;
      if (key === 'exported') cur.exported = /^(true|0xffffffff|-1|1)$/i.test(val);
    }
    if (/android\.intent\.category\.LAUNCHER/.test(t)) cur.launcher = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** The activity carrying the LAUNCHER category, or null. */
export function launcherActivity(xmltree) {
  return parseActivities(xmltree).find((a) => a.launcher) || null;
}

/**
 * Can `am start -n <pkg>/<activity>` reach it?
 * @returns {{ok: boolean, reason: string}}
 */
export function canAmStart(xmltree, component) {
  const want = String(component || '').split('/').pop();
  const acts = parseActivities(xmltree);
  const byName = acts.find((a) => a.name === want
    || (want.startsWith('.') && String(a.name || '').endsWith(want)));
  if (!byName) {
    return { ok: false, reason: `no activity named ${want} in the shipped manifest — `
                               + `am start would report "does not exist"` };
  }
  if (byName.exported !== true) {
    return { ok: false, reason: `${byName.name} is not exported (exported=${byName.exported}) — `
                               + 'am start from adb is refused with a SecurityException, so the '
                               + 'app never runs and nothing of ours reaches logcat' };
  }
  return { ok: true, reason: `${byName.name} is exported` };
}

/** The text `am start` prints when the component is not exported. */
export function parseAmStartRefusal(out) {
  const t = String(out || '');
  if (/SecurityException[^\n]*not exported/i.test(t)
      || /Permission Denial[^\n]*not exported/i.test(t)) {
    return 'the launch component is not exported — Android refused the start';
  }
  if (/does not exist|Activity class .* does not exist/i.test(t)) {
    return 'the launch component does not exist under that name';
  }
  if (/Error type 3|Error: Activity not started/i.test(t)) {
    return (/Error type 3/.test(t) ? 'the launch component does not exist under that name'
                                   : 'am start reported the activity was not started');
  }
  return null;
}

/**
 * Classify what `adb install -r` said, and say what to do about it.
 *
 * WHY THIS IS NOT JUST A STRING. Every other install failure here is annoying; ONE of them has
 * an obvious next step that destroys something irreplaceable.
 *
 *   INSTALL_FAILED_UPDATE_INCOMPATIBLE — the APK is signed by a different certificate than the
 *   copy already on the phone. `-r` cannot replace across signers. The documented fix, the first
 *   search result, and the thing adb itself nudges you toward is `adb uninstall` — which wipes
 *   app-private storage, and the IdentityStore keypair lives there. That keypair is what the
 *   sidecar's allowlist pins. Uninstalling rotates the phone's identity, the gateway then
 *   refuses it as an unknown client, and recovering means re-pairing a handset to fix a build
 *   flag.
 *
 * So the run must not print the raw stderr and leave the operator to reach for the obvious. It
 * has to name the cause AND name the wrong move, before anyone types it.
 *
 * @returns {{code: string, verdict: string, doNotUninstall: boolean}|null} null when it succeeded
 */
export function parseInstallFailure(out) {
  const t = String(out || '');
  if (!t.trim()) return { code: 'NO_OUTPUT', doNotUninstall: false,
                          verdict: 'adb install printed nothing at all — it did not run' };
  if (/\bSuccess\b/.test(t)) return null;

  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_SHARED_USER_INCOMPATIBLE|signatures do not match/i.test(t)) {
    return {
      code: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
      doNotUninstall: true,
      verdict: 'SIGNER MISMATCH: this APK is signed by a different certificate than the copy on '
             + 'the phone, so `-r` cannot replace it. DO NOT UNINSTALL — app-private storage '
             + 'holds the IdentityStore keypair the sidecar allowlist pins, and removing it '
             + 'rotates the phone\'s identity, after which the gateway refuses it as an unknown '
             + 'client and the handset has to be re-paired. Rebuild with the same keystore '
             + '(android/app/build.gradle signs release with ~/.android/debug.keystore for '
             + 'exactly this reason) and install again.',
    };
  }
  const known = [
    [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, 'INSTALL_FAILED_INSUFFICIENT_STORAGE',
     'the phone is out of space for the APK'],
    [/INSTALL_FAILED_OLDER_SDK/i, 'INSTALL_FAILED_OLDER_SDK',
     'the APK\'s minSdk is above this phone\'s Android version'],
    [/INSTALL_FAILED_NO_MATCHING_ABIS/i, 'INSTALL_FAILED_NO_MATCHING_ABIS',
     'the APK carries no native code for this phone\'s CPU'],
    [/INSTALL_FAILED_VERSION_DOWNGRADE/i, 'INSTALL_FAILED_VERSION_DOWNGRADE',
     'the phone has a NEWER versionCode installed; bump it or install with -d'],
    [/INSTALL_FAILED_USER_RESTRICTED|user restriction/i, 'INSTALL_FAILED_USER_RESTRICTED',
     'the phone refused the install — "Install via USB" may be off in Developer options'],
    [/device unauthorized|device still authorizing/i, 'UNAUTHORIZED',
     'the phone has not accepted this computer\'s adb key yet'],
    [/no devices\/emulators found|device .* not found/i, 'NO_DEVICE',
     'adb lost the device between discovery and install'],
  ];
  for (const [re, code, why] of known) {
    if (re.test(t)) return { code, doNotUninstall: false, verdict: `${code}: ${why}` };
  }
  return { code: 'UNKNOWN', doNotUninstall: false,
           verdict: `install failed and the reason is not one this run recognises: `
                  + `${t.replace(/\s+/g, ' ').trim().slice(0, 160)}` };
}
