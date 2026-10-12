const DEFAULTS = Object.freeze({
  impactPosition: "near-end",
  beatSync: "balanced",
  detectDoubleTaps: true,
  removeMedalWatermark: false
});

function parseEditInstructions(value) {
  const text = String(value || "").trim().toLowerCase();
  const preferences = { ...DEFAULTS };
  const matched = [];
  if (!text) return { text: "", preferences, matched };

  if (/(kills?|eliminations?|treffer|impacts?).{0,35}(am ende|ans ende|at the end|end of)/i.test(text)
      || /(jeder|each|every).{0,18}(clip|szene).{0,35}(kill|elimination).{0,18}(ende|end)/i.test(text)) {
    preferences.impactPosition = "end";
    matched.push("impact-at-end");
  } else if (/(kill|impact|treffer).{0,30}(mittig|in der mitte|center|middle)/i.test(text)) {
    preferences.impactPosition = "center";
    matched.push("impact-at-center");
  }

  if (/(streng|exakt|genau|strict|exact).{0,18}(beat|hit|takt)/i.test(text)
      || /(beat|hit|takt).{0,18}(streng|exakt|genau|strict|exact)/i.test(text)) {
    preferences.beatSync = "strict";
    matched.push("strict-beat-sync");
  }
  if (/(kein|ohne|disable|no).{0,18}(d[- ]?tap|double.{0,8}(crystal|tap))/i.test(text)) {
    preferences.detectDoubleTaps = false;
    matched.push("disable-double-tap");
  }
  if (/(wasserzeichen|watermark).{0,24}(entfern|weg|crop|remove)/i.test(text)
      || /(entfern|weg|crop|remove).{0,24}(wasserzeichen|watermark)/i.test(text)) {
    preferences.removeMedalWatermark = true;
    matched.push("remove-medal-watermark");
  }
  return { text: String(value || "").trim(), preferences, matched };
}

module.exports = { DEFAULTS, parseEditInstructions };
