import { cleanTextForTTS } from './shared/readAloudText.js';

const samples = [
  '他看到了内心想杀人的这一冲动…… 然后它便消失了。',
  '他看到了内心想杀人的这一冲动... 然后它便消失了。',
  '桥……他以前从未注意过它',
  '单个省略号…也应该被替换',
  '没有省略号的句子，保持原样。'
];

for (const s of samples) {
  console.log('IN :', s);
  console.log('OUT:', cleanTextForTTS(s));
  console.log('---');
}
