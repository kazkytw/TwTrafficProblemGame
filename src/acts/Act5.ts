import type { Act } from '../types';

export const act5: Act = {
  id: 'act5',
  async run(ctx) {
    ctx.ui.clearAll();
    ctx.ui.setBlack(true);
    await ctx.wait(600);
    // black layer sits above cards, so the closing fact card is rendered as narration text on black
    await ctx.ui.narration('每年，約一萬七千名行人發生交通事故，\n其中有些人再也沒有回家。', 5200,'資料來源：未來城市＠天下｜台灣為何被稱為「行人地獄」？', 1500);
    await ctx.wait(500);
  },
};
