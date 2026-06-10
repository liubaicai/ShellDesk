function decodePowerShellCliXmlText(value) {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractPowerShellCliXmlMessages(value) {
  const messages = [];
  const xmlTextRegex = /<S(?:\s+[^>]*)?>([\s\S]*?)<\/S>/g;
  let match;

  while ((match = xmlTextRegex.exec(value)) !== null) {
    const message = decodePowerShellCliXmlText(match[1]).trim();

    if (message) {
      messages.push(message);
    }
  }

  return messages.join('\n');
}

function cleanPowerShellCliXmlOutput(value, options = {}) {
  const cleaned = String(value || '')
    .replace(/#< CLIXML[ \t]*(?:\r?\n)?/g, '')
    .replace(/<Objs\b[\s\S]*?<\/Objs>/g, (cliXml) => extractPowerShellCliXmlMessages(cliXml))
    .replace(/<Objs\b[\s\S]*$/g, (cliXml) => extractPowerShellCliXmlMessages(cliXml))
    .split(/\r?\n/);

  const lines = options.preservePlainTextWhitespace
    ? cleaned
    : cleaned.map((line) => line.trimEnd());

  return lines
    .filter((line) => line.trim() !== '#< CLIXML')
    .join('\n');
}

function getTrailingCliXmlPrefixLength(value) {
  const prefixes = ['#< CLIXML', '<Objs'];
  let prefixLength = 0;

  for (const prefix of prefixes) {
    for (let index = 2; index < prefix.length; index += 1) {
      if (value.endsWith(prefix.slice(0, index))) {
        prefixLength = Math.max(prefixLength, index);
      }
    }
  }

  return prefixLength;
}

function createPowerShellCliXmlStreamCleaner(options = {}) {
  let buffer = '';

  const push = (text = '', flush = false) => {
    buffer += text;
    let output = '';

    while (buffer) {
      const xmlStart = buffer.indexOf('<Objs');

      if (xmlStart === -1) {
        if (!flush) {
          const trailingPrefixLength = getTrailingCliXmlPrefixLength(buffer);

          if (trailingPrefixLength > 0) {
            output += cleanPowerShellCliXmlOutput(buffer.slice(0, -trailingPrefixLength), options);
            buffer = buffer.slice(-trailingPrefixLength);
            break;
          }
        }

        output += cleanPowerShellCliXmlOutput(buffer, options);
        buffer = '';
        break;
      }

      output += cleanPowerShellCliXmlOutput(buffer.slice(0, xmlStart), options);

      const xmlEnd = buffer.indexOf('</Objs>', xmlStart);

      if (xmlEnd === -1) {
        if (flush) {
          output += cleanPowerShellCliXmlOutput(buffer.slice(xmlStart), options);
          buffer = '';
        } else {
          buffer = buffer.slice(xmlStart);
        }

        break;
      }

      const xmlCloseEnd = xmlEnd + '</Objs>'.length;
      output += extractPowerShellCliXmlMessages(buffer.slice(xmlStart, xmlCloseEnd));
      buffer = buffer.slice(xmlCloseEnd);
    }

    return output;
  };

  return { push };
}

module.exports = {
  cleanPowerShellCliXmlOutput,
  createPowerShellCliXmlStreamCleaner,
};
