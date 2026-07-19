/**
 * 主Agent（对话前门，DESIGN §4.1）
 * 每条笔记一个独立对话线程：只围绕当前笔记，带它的纲要 + 用户笔记 + 历史对话。
 * 用【标签格式】而非 JSON——content 里含引号/换行也不会解析崩。
 * 更新纲要时必须保留已有内容，绝不覆盖用户写的东西。
 * 计费后端可切换（Claude Code 订阅 / Anthropic API），见 llm.mjs。
 */
import { callText } from './llm.mjs';

function parseTags(text) {
  const g = (tag) => {
    const m = text.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? m[1].trim() : '';
  };
  return { reply: g('reply'), amplitude: Number(g('amplitude')) || 0, goal: g('goal'), title: g('title'), content: g('content') };
}

export async function converse({ message, node }) {
  let prompt;
  if (node) {
    const history = (node.chat || []).slice(-12)
      .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.text}`).join('\n');
    prompt = `你是「愿力引擎」的主Agent，正在就【这一条笔记】和用户对话。只围绕这条笔记，不要扯到别的笔记。

【笔记标题】${node.title}
【现有纲要】（你维护的；更新时必须保留已有内容，不许删用户/你之前写的）
${(node.content || '(空)').trim()}
【用户私人笔记】（只读，绝不改动或复述覆盖）
${(node.userNote || '(无)').trim()}
【最近对话】
${history || '(无)'}

用户刚说：
${message}

严格用下面的标签格式回复，标签外不要写任何字：
<reply>给用户的简短回复，1~2 句，像聊天</reply>
<amplitude>0~40 的整数，这句话对"推进这件事"的愿力强度；闲聊给低分</amplitude>
<goal>一句话概括用户这次想推进什么</goal>
<content>更新后的【完整】纲要(Markdown)，在现有基础上补充/细化，绝不删已有内容；这次不改纲要就整段留空</content>`;
  } else {
    prompt = `你是「愿力引擎」的主Agent。用户想开一件新的事，把它整理成一条新笔记。

用户说：
${message}

严格用下面的标签格式回复，标签外不要写任何字：
<reply>简短回复</reply>
<amplitude>0~40 的整数愿力强度</amplitude>
<goal>一句话概括</goal>
<title>简短标题</title>
<content>纲要(Markdown，含 ## 目标 / ## 约束 / ## 行动计划)</content>`;
  }
  const { text, cost } = await callText(prompt);
  const parsed = parseTags(text);
  parsed._cost = cost;
  return parsed;
}
