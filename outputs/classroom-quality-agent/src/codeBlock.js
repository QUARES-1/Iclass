// Source is plain text. Never normalize whitespace or mathematical operators.
export function validateCodeBlock(code) {
  if (code === null || code === undefined) return undefined;
  if (!code || typeof code !== 'object' || Array.isArray(code) || typeof code.source !== 'string' || !code.source.trim() || code.source.length > 60000 || code.source.includes('\0')) throw new Error('示例代码须提供非空 source，最多 60000 字符。');
  if (code.language !== undefined && (typeof code.language !== 'string' || code.language.length > 40 || /[\r\n\0]/.test(code.language))) throw new Error('代码语言格式无效。');
  if (code.expectedOutput !== undefined && (typeof code.expectedOutput !== 'string' || code.expectedOutput.length > 10000 || code.expectedOutput.includes('\0'))) throw new Error('代码预期输出格式无效。');
  if (code.kind !== undefined && !['source','output'].includes(code.kind)) throw new Error('代码块类型无效。');
  if(code.replaceBlock!==undefined&&typeof code.replaceBlock!=='boolean')throw new Error('整段代码替换标记无效。');
  if(code.blockId!==undefined&&(typeof code.blockId!=='string'||!/^[a-z0-9-]{1,80}$/i.test(code.blockId)))throw new Error('代码块 ID 无效。');
  for(const field of ['part','parts'])if(code[field]!==undefined&&(!Number.isSafeInteger(code[field])||code[field]<1||code[field]>10000))throw new Error('代码分段编号无效。');
  return { language: code.language || 'text', source: code.source, ...(code.expectedOutput ? { expectedOutput: code.expectedOutput } : {}), ...Object.fromEntries(['kind','blockId','part','parts'].filter(k=>code[k]!==undefined).map(k=>[k,code[k]])) };
}

function lineRows(line){const units=[...line.replace(/\r?\n$/, '')].reduce((n,c)=>n+(c==='\t'?4:c.charCodeAt(0)>255?2:1),0);return Math.max(1,Math.ceil(units/88));}
export function codeDisplayRows(source){return (source.match(/[^\n]*\n|[^\n]+$/g)||[]).reduce((n,line)=>n+lineRows(line),0);}

// Mask literals and comments before finding structural boundaries. Keeping the
// original strings separate means pagination never rewrites executable code.
function structuralLines(lines,python){
  let comment=false,quote='',rawEnd='',escaped=false,regexClass=false;
  return lines.map(line=>{
    let visible='';
    for(let i=0;i<line.length;i++){
      if(rawEnd){if(line.startsWith(rawEnd,i)){i+=rawEnd.length-1;rawEnd='';}visible+=' ';continue;}
      if(comment){if(line.startsWith('*/',i)){comment=false;i++;}visible+=' ';continue;}
      if(quote){if(escaped)escaped=false;else if(line[i]==='\\')escaped=true;else if(quote==='/'&&line[i]==='[')regexClass=true;else if(quote==='/'&&line[i]===']')regexClass=false;else if(line[i]===quote&&!regexClass)quote='';visible+=' ';continue;}
      if(python&&line[i]==='#'||!python&&line.startsWith('//',i))break;
      if(!python&&line.startsWith('/*',i)){comment=true;i++;visible+=' ';continue;}
      const raw=!python&&line.slice(i).match(/^R"([^\s()\\]{0,16})\(/);
      if(raw){rawEnd=')'+raw[1]+'"';i+=raw[0].length-1;visible+=' ';continue;}
      if(python&&(line.startsWith('"""',i)||line.startsWith("'''",i))){rawEnd=line.slice(i,i+3);i+=2;visible+=' ';continue;}
      if(!python&&line[i]==="'"&&/\d/.test(line[i-1]||'')&&/\d/.test(line[i+1]||'')){visible+=' ';continue;}
      if(!python&&line[i]==='/'&&/(?:^|[=(:,!&|?;{}]|\breturn)\s*$/.test(visible)){quote='/';regexClass=false;visible+=' ';continue;}
      if(['"',"'",'`'].includes(line[i])){quote=line[i];visible+=' ';continue;}
      visible+=line[i];
    }
    return visible;
  });
}

// Names are presentation labels only. Ignore strings, comments and control-flow
// constructs; this does not check or rewrite the program.
export function codeFunctionNames(source,language='text'){
  const python=/^(py|python)/i.test(language);
  const visible=structuralLines(String(source).split(/\r?\n/),python).join('\n');
  const matches=python?[...visible.matchAll(/\b(?:async\s+)?def\s+(\w+)\s*\(/g)]:[...visible.matchAll(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->[^{}]+)?\{/g)];
  const controls=new Set(['if','for','while','switch','catch','sizeof','alignof']);
  return [...new Set(matches.map(m=>m[1]).filter(name=>!controls.has(name)))];
}

function semanticEnds(lines,language){
  const python=/^(py|python)/i.test(language)||lines.some(line=>/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(line));
  const visible=structuralLines(lines,python),ends=new Set([0,lines.length]),insideEnds=new Set([0,lines.length]);
  if(python){
    const spans=[];
    for(let i=0;i<visible.length;i++)if(/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(visible[i])){
      const indent=visible[i].match(/^\s*/)[0].replaceAll('\t','    ').length;
      let start=i;while(start&&/^\s*@/.test(visible[start-1]))start--;
      let end=i+1;while(end<visible.length&&(!visible[end].trim()||visible[end].match(/^\s*/)[0].replaceAll('\t','    ').length>indent))end++;
      spans.push({start,end});
    }
    const outer=spans.filter(s=>!spans.some(parent=>parent!==s&&parent.start<s.start&&parent.end>=s.end));
    for(const s of outer){ends.add(s.start);ends.add(s.end);}
    for(let i=1;i<lines.length;i++)if(!outer.some(s=>i>s.start&&i<s.end))ends.add(i);
    // An oversized Python function can continue at a blank line or a complete
    // statement; its indentation is preserved verbatim on the next page.
    for(let i=1;i<lines.length;i++)if(!visible[i-1].trim()||!/[:\\([{,]\s*$/.test(visible[i-1]))insideEnds.add(i);
    return {ends,insideEnds};
  }
  const scopes=[];let parens=0,brackets=0,header='';
  for(let i=0;i<visible.length;i++){
    const line=visible[i];
    for(const c of line){
      if(c==='(')parens++;if(c===')')parens=Math.max(0,parens-1);
      if(c==='[')brackets++;if(c===']')brackets=Math.max(0,brackets-1);
      if(c==='{'){scopes.push(/\b(?:class|struct|namespace|interface|enum)\b[^;{}]*$/.test(header));header='';}
      else if(c==='}'){scopes.pop();header='';}
      else if(c===';')header='';else header=(header+c).slice(-500);
    }
    const complete=/[;}]\s*$/.test(line),next=visible[i+1]?.trim()||'';
    const continuation=/^(?:else\b|catch\b|finally\b|while\s*\(|[{: ,])/.test(next);
    if(!parens&&!brackets&&!continuation){
      if((complete||/^\s*#/.test(line))&&scopes.every(Boolean))ends.add(i+1);
      if(complete&&scopes.filter(s=>!s).length<=1)insideEnds.add(i+1);
    }
    header+=' ';
  }
  return {ends,insideEnds};
}

export function splitCodeSource(source, maxRows = 20, language = 'text') {
  const lines=source.match(/[^\n]*\n|[^\n]+$/g)||[],{ends,insideEnds}=semanticEnds(lines,language),hardRows=Math.ceil(maxRows*1.4);
  if(ends.size<=2&&!/\)\s*(?:const\s*|noexcept\s*)?\{|(?:async\s+)?def\s+\w+\s*\(/.test(source))return splitCodeOutput(source,maxRows);
  const sorted=[...ends].sort((a,b)=>a-b),units=[];
  for(let i=1;i<sorted.length;i++)units.push(lines.slice(sorted[i-1],sorted[i]));
  const chunks=[];let pending=[],rows=0;
  const flush=()=>{if(pending.length){chunks.push(pending.join(''));pending=[];rows=0;}};
  let offset=0;
  for(const unit of units){
    const load=unit.reduce((n,line)=>n+lineRows(line),0);
    if(unit.some(line=>lineRows(line)>maxRows))throw new Error('示例代码单行过长，请用语言允许的换行写法拆分。');
    if(load<=hardRows){
      // A slightly longer complete function gets a page of its own. Small
      // declarations and closing braces can share that page without being orphaned.
      if(rows+load>maxRows&&!(rows<=4&&rows+load<=hardRows)&&!(load<=3&&rows+load<=hardRows))flush();
      pending.push(...unit);rows+=load;
    }else{
      flush();let start=0;
      while(start<unit.length){
        let end=start,load=0,lastStatement=start;
        while(end<unit.length&&load+lineRows(unit[end])<=maxRows){load+=lineRows(unit[end]);end++;if(insideEnds.has(offset+end))lastStatement=end;}
        if(lastStatement===start&&end<unit.length){
          let look=end,expanded=load;
          while(look<unit.length&&expanded+lineRows(unit[look])<=hardRows){
            expanded+=lineRows(unit[look]);look++;
            if(insideEnds.has(offset+look)){end=look;load=expanded;lastStatement=look;break;}
          }
        }
        const tail=unit.slice(end).reduce((n,line)=>n+lineRows(line),0);if(tail<=3&&load+tail<=hardRows)end=unit.length;
        if(end<unit.length&&lastStatement>start)end=lastStatement;
        chunks.push(unit.slice(start,end).join(''));start=end;
      }
    }
    offset+=unit.length;
  }
  flush();
  return chunks;
}

// Plain output has no function boundaries.
export function splitCodeOutput(source, maxRows = 20) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [], chunks=[];
  let text='',rows=0;
  for(const line of lines){
    const height=lineRows(line);
    if(height>maxRows)throw new Error('示例代码单行过长，请用语言允许的换行写法拆分。');
    if(text && rows+height>maxRows){chunks.push(text);text='';rows=0;}
    text+=line;rows+=height;
  }
  if(text)chunks.push(text);
  if(chunks.length>1){
    const last=chunks.at(-1).match(/[^\n]*\n|[^\n]+$/g)||[],prev=chunks.at(-2).match(/[^\n]*\n|[^\n]+$/g)||[];
    let load=last.reduce((n,line)=>n+lineRows(line),0);
    if(load<=3){
      const target=Math.ceil((load+prev.reduce((n,line)=>n+lineRows(line),0))/2);
      while(prev.length>1&&load<target&&load+lineRows(prev.at(-1))<=maxRows){const line=prev.pop();last.unshift(line);load+=lineRows(line);}
      chunks[chunks.length-2]=prev.join('');chunks[chunks.length-1]=last.join('');
    }
  }
  return chunks;
}
