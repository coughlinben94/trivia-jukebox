import { mergeHueSiblings, buildWeights } from './api/palette.js';

const colors  = ["#e89c00","#1169b6","#cc0000","#f2a61b","#005096"];
const weights = [0.09528646891507517,0.38094270621698495,0.047541649735879724,0.09528646891507517,0.38094270621698495];
const hues    = { "#e89c00":40.3, "#1169b6":208, "#cc0000":0, "#f2a61b":38.8, "#005096":208 };

const byHex = new Map(colors.map((hex,i) => [hex, { hue: hues[hex], population: weights[i] }]));

console.log('BEFORE merge:', colors, weights);

const HUE_GAP_DEG = 25;
const merged = mergeHueSiblings(colors, byHex, HUE_GAP_DEG);
const newWeights = buildWeights(merged.map(hex => ({ population: byHex.get(hex)?.population ?? null })));

console.log('AFTER merge: ', merged, newWeights);
