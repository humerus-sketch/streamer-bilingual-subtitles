import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBenchmark, lengthBucket } from './benchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const originals = readJson(join(here, 'fixtures.json'));
// Independently specified synthetic reference wording, not a human gold standard or an exact-match metric.
const referencePairs = [
  ['直播还没有开始，今晚九点开始。', 'The stream has not started yet. It starts at nine tonight.'],
  ['昨天没有崩溃，但今天已经崩溃两次了。', 'It did not crash yesterday, but it has already crashed twice today.'],
  ['不是做不到，只是现在不想做。', 'It is not that I cannot do it; I just do not want to right now.'],
  ['两个人请各拿一个，总共两个。', 'Please take one each, two in total between the two of you.'],
  ['每次250毫秒，四次就是一秒。', 'Each time takes 250 milliseconds, so four times takes one second.'],
  ['如果赶不上，这次可以不参加。', 'If you cannot make it in time, you do not have to join this time.'],
  ['打倒这个Boss之前不要回血。', 'Do not heal until this boss is defeated.'],
  ['我把装备交给了Yuki。', 'I gave the equipment to Yuki.'],
  ['Yuki帮我回血了。', 'Yuki healed me.'],
  ['明明跟队友说了别进去，队友还是进去了。', 'I told my teammate not to go in, but they went in anyway.'],
  ['又团灭了啊。哎呀，真是完美的作战计划呢。', 'Another party wipe. Wow, that was a perfect plan.'],
  ['Kanae，谢谢你的醒目留言！接下来要挑战月影了。', 'Kanae, thanks for the Super Chat! Next, I am taking on Tsukikage.'],
  ['右边，不对，是左边！啊，还是右边没错。', 'Right, no, left! Oh, right was correct after all.'],
  ['拿到了，已经把钥匙放在入口了。', 'I got the key and left it at the entrance.'],
  ['比以前更快了，但还不是最快的。', 'It is faster than before, but it is still not the fastest.'],
  ['我想大概再过三分钟左右结束，不过还不确定。', 'I think it will probably be over in about three more minutes, but it is not certain.'],
  ['说过明天来不了的不是我，是Ken。', 'It was Ken, not me, who said they could not come tomorrow.'],
  ['不要全卖掉。只留下稀有物品，其他的可以卖。', 'Do not sell everything. Keep only the rare items; you can sell the rest.'],
];
if (originals.cases.length !== referencePairs.length) throw new Error('Original regression cases changed; review references first.');
const sources = ['general-162.json', 'game-160.json', 'complex-160.json'];
const inputs = sources.map(name => ({ name, bytes: readFileSync(join(here, 'corpus', name)) }));
const additions = inputs.flatMap(item => JSON.parse(item.bytes.toString('utf8')));
const regression = originals.cases.map((c, i) => ({ ...c, category: 'regression', source_group: 'prior_18_exposed', reference: { zh: referencePairs[i][0], en: referencePairs[i][1] } }));
const cases = [...regression, ...additions.map(c => ({ ...c, source_group: 'new_synthetic_482' }))];
const fixture = { version: '2.0-500-frozen', description: '500 distinct synthetic Japanese utterances: 18 exposed regression cases and 482 newly authored cases with model-authored references/checkpoints. Not recordings or a human-reviewed public benchmark. Private references/checkpoints never enter translation requests. No exact-match accuracy score.', glossary: originals.glossary, cases };
const config = readJson(join(here, 'benchmark-500.json'));
validateBenchmark(config, fixture);
const lengths = Object.fromEntries(['short_1_40','medium_41_99','long_100_plus'].map(b => [b, cases.filter(c => lengthBucket(c.ja) === b).length]));
if (lengths.long_100_plus < 100) throw new Error('At least 100 naturally composed long cases of >=100 Japanese code points are required.');
const content = JSON.stringify(fixture, null, 2) + '\n';
const manifest = {
  created_at: new Date().toISOString(), case_count: cases.length, prior_regression_count: regression.length, new_synthetic_count: additions.length,
  length_rule: 'Unicode code points of ja: short 1..40, medium 41..99, long >=100.', lengths,
  categories: Object.fromEntries([...new Set(cases.map(c => c.category))].sort().map(k => [k, cases.filter(c => c.category === k).length])),
  fixture_file_sha256: hash(content), fixture_object_sha256: hash(JSON.stringify(fixture)),
  part_sources: inputs.map(i => ({ file: i.name, sha256: hash(i.bytes), count: JSON.parse(i.bytes.toString('utf8')).length })),
  limitations: ['Synthetic model-authored Japanese and references, not native-speaker-reviewed gold data.', 'The 18 regression cases were previously exposed; report them separately from new cases.', 'One pass of 500 cases measures this workload/time window, not repeated performance on each sentence or real speech accuracy.'],
};
for (const name of ['fixtures-500.json','manifest-500.json']) if (existsSync(join(here, 'corpus', name))) throw new Error('Refusing to overwrite a frozen corpus: ' + name);
writeFileSync(join(here, 'corpus', 'fixtures-500.json'), content, { flag: 'wx' });
writeFileSync(join(here, 'corpus', 'manifest-500.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ frozen_cases: cases.length, lengths, sha256: manifest.fixture_file_sha256 }));
