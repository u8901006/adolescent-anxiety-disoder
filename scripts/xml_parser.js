export class XMLParser {
  parse(xml) {
    const doc = this._parseToDoc(xml);
    return doc;
  }

  _parseToDoc(xml) {
    const stack = [{}];
    const tagStack = [];
    let i = 0;

    while (i < xml.length) {
      if (xml[i] === '<') {
        if (xml[i + 1] === '?') {
          i = xml.indexOf('?>', i) + 2;
          continue;
        }
        if (xml[i + 1] === '!' && xml.substring(i, i + 4) === '<!--') {
          i = xml.indexOf('-->', i) + 3;
          continue;
        }
        if (xml[i + 1] === '/') {
          const end = xml.indexOf('>', i);
          const tagName = xml.substring(i + 2, end).trim();
          const current = stack.pop();
          tagStack.pop();
          const parent = stack[stack.length - 1];
          const parentTag = tagStack[tagStack.length - 1];
          if (parentTag) {
            if (parent[parentTag] === undefined) {
              parent[parentTag] = current;
            } else if (Array.isArray(parent[parentTag])) {
              parent[parentTag].push(current);
            } else {
              parent[parentTag] = [parent[parentTag], current];
            }
          } else {
            stack.push(current);
            tagStack.push(tagName);
          }
          i = end + 1;
          continue;
        }
        const end = xml.indexOf('>', i);
        let tagContent = xml.substring(i + 1, end);
        const selfClosing = tagContent.endsWith('/');
        if (selfClosing) tagContent = tagContent.slice(0, -1);

        const spaceIdx = tagContent.indexOf(' ');
        let tagName, attrs;
        if (spaceIdx === -1) {
          tagName = tagContent.trim();
          attrs = '';
        } else {
          tagName = tagContent.substring(0, spaceIdx).trim();
          attrs = tagContent.substring(spaceIdx + 1).trim();
        }

        const node = this._parseAttrs(attrs);

        if (selfClosing) {
          const parent = stack[stack.length - 1];
          if (parent[tagName] === undefined) {
            parent[tagName] = node;
          } else if (Array.isArray(parent[tagName])) {
            parent[tagName].push(node);
          } else {
            parent[tagName] = [parent[tagName], node];
          }
        } else {
          stack.push(node);
          tagStack.push(tagName);
        }
        i = end + 1;
      } else {
        const end = xml.indexOf('<', i);
        const text = end === -1 ? xml.substring(i) : xml.substring(i, end);
        const trimmed = text.trim();
        if (trimmed) {
          const current = stack[stack.length - 1];
          if (current['#text'] === undefined) {
            current['#text'] = trimmed;
          } else {
            current['#text'] += trimmed;
          }
        }
        i = end === -1 ? xml.length : end;
      }
    }

    return stack[0];
  }

  _parseAttrs(attrStr) {
    const node = {};
    if (!attrStr) return node;
    const regex = /(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = regex.exec(attrStr)) !== null) {
      node[`@_${match[1]}`] = match[2] ?? match[3];
    }
    return node;
  }
}
