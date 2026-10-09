// Prints the odds and return-to-player of every default machine.
import { DEFAULT_MACHINES } from '../src/defaults.js';
import { analyze } from '../shared/paytable.js';

for (const m of DEFAULT_MACHINES) {
  const a = analyze(m);
  const total = (a.rtp + m.jackpotContribution / 100) * 100;
  console.log(
    `${m.name.padEnd(16)} ${a.lines} lines  RTP ${(a.rtp * 100).toFixed(1).padStart(5)}% ` +
      `(lines ${(a.lineRtp * 100).toFixed(1)}%, scatter ${(a.scatterRtp * 100).toFixed(1)}%) ` +
      `+jackpot ${m.jackpotContribution}% = ${total.toFixed(1)}%  ` +
      `win 1 in ${(1 / a.hitRate).toFixed(1).padStart(4)}  jackpot 1 in ${a.jackpotOdds.toLocaleString('en-US')}`
  );
}
