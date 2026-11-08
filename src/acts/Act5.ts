import type { Act } from '../types';

export const act5: Act = {
  id: 'act5',
  async run(ctx) {
    ctx.ui.clearAll();
    ctx.ui.setBlack(true);
    await ctx.wait(600);
    // black layer sits above cards, so the closing fact card is rendered as narration text on black
    await ctx.ui.narration('事故資料：公視專題指出，約半數行人事故發生在路口。', 5200);
    await ctx.wait(500);
  },
};
