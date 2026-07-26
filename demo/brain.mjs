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
  let reply = g('reply');
  // 兜底：模型有时（尤其联网查完写长回答时）忘了套 <reply> 标签。
  // 这时不要丢掉它说的话——把 amplitude/goal/title/content 整块删掉，剩下的散文当作回复。
  if (!reply) {
    const stripped = text
      .replace(/<(amplitude|goal|title|content)>[\s\S]*?<\/\1>/gi, '') // 删完整标签块
      .replace(/<\/?[a-z]+>/gi, '')                                     // 删残留孤立标签
      .trim();
    if (stripped) reply = stripped;
  }
  return { reply, amplitude: Number(g('amplitude')) || 0, goal: g('goal'), title: g('title'), content: g('content') };
}

// 主Agent 的角色边界：可【轻量联网查询】即时答疑；重活（写文件/多步落地）交执行引擎。
const ROLE = `【你的角色与能力，务必遵守】
你负责：跟用户对话答疑、维护这条笔记的纲要、按用户的在意程度赋予愿力。
你【有】联网工具 WebSearch / WebFetch，可以做【轻量、即时】的查询——用户问"查一下/怎么做/是什么/XX 怎么实现"这类能较快查到的问题，你就【当场用工具查，把答案直接写进 <reply>】，不要推给引擎、不要说"愿力够了引擎会去查"这种话（那会显得敷衍）。
你【不做】的重活：读写文件、跑代码、克隆/分析整个代码库、需要多步骤长时间产出交付物——这些才交给「执行引擎」，它在愿力激发后自动完成，产物出现在「交付物」「重要发现」里。
判断标准：能在一两次搜索里当场答清 → 你自己查了答；要动文件/跑命令/深度多步 → 记进纲要交引擎。
【绝对不要】说"没授权/需要开权限/需要批准访问目录"这类话。
【读本地代码库】用户想让引擎读某本地目录，只需把完整路径（如 D:\\code\\AgentSwarm）写进纲要，引擎执行时会自动挂载可读。`;

export async function converse({ message, node }) {
  let prompt;
  if (node) {
    const history = (node.chat || []).slice(-12)
      .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.text}`).join('\n');
    prompt = `你是「愿力引擎」的主Agent，正在就【这一条笔记】和用户对话。只围绕这条笔记，不要扯到别的笔记。

${ROLE}

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
<reply>给用户的回复。闲聊就 1~2 句；若用户在问问题/让你查，就【先用 WebSearch/WebFetch 查】再把答案写在这里，可以详细、分点</reply>
<amplitude>0~40 的整数，这句话对"推进这件事"的愿力强度；闲聊给低分</amplitude>
<goal>一句话概括用户这次想推进什么</goal>
<content>更新后的【完整】纲要(Markdown)，在现有基础上补充/细化，绝不删已有内容；这次不改纲要就整段留空</content>`;
  } else {
    prompt = `你是「愿力引擎」的主Agent。用户想开一件新的事，把它整理成一条新笔记。

${ROLE}

用户说：
${message}

严格用下面的标签格式回复，标签外不要写任何字：
<reply>简短回复</reply>
<amplitude>0~40 的整数愿力强度</amplitude>
<goal>一句话概括</goal>
<title>简短标题</title>
<content>纲要(Markdown，含 ## 目标 / ## 约束 / ## 行动计划)</content>`;
  }
  const { text, cost } = await callText(prompt, { tools: 'WebSearch,WebFetch' });
  const parsed = parseTags(text);
  parsed._cost = cost;
  return parsed;
}
