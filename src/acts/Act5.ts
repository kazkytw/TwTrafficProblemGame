import type { Act } from '../types';

export const act5: Act = {
  id: 'act5',
  async run(ctx) {
    ctx.ui.clearAll();
    ctx.ui.setBlack(true);
    await ctx.wait(600);
    // black layer sits above cards, so the closing fact card is rendered as narration text on black
    await ctx.ui.narration('每年近 8000 名行人在路口遭撞，\n其中有些人再也沒有回家。', 5200,'資料來源：道安資訊查詢網、公視專題《行人地獄》', 1500);
    await ctx.wait(500);
  },
};
