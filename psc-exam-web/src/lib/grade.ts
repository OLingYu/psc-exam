/** 等级认定（依据《普通话水平测试等级标准》） */
export function levelOf(total: number): string {
  if (total >= 97) return '一级甲等';
  if (total >= 92) return '一级乙等';
  if (total >= 87) return '二级甲等';
  if (total >= 80) return '二级乙等';
  if (total >= 70) return '三级甲等';
  if (total >= 60) return '三级乙等';
  return '不入级';
}

export const LEVEL_DESC: Record<string, string> = {
  一级甲等: '语音标准，词汇语法规范，自然流畅，可担任播音员、主持人。',
  一级乙等: '语音标准，词汇语法规范，朗读和自由交谈时语调自然、表达流畅。',
  二级甲等: '声韵调发音基本标准，语调自然，表达流畅，教师、导游等岗位常见要求。',
  二级乙等: '个别调值不准，声韵母发音有不到位现象，方音不明显。',
  三级甲等: '声韵母发音失误较多，方音明显，语调不够自然。',
  三级乙等: '声韵母发音失误多，方音重，语调生硬。',
  不入级: '未达到三级乙等，建议从声韵调基本功开始系统练习。',
};

export const fmtScore = (n: number): string => {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
