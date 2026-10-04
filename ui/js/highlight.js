'use strict';

    function highlight(code, lang) {
      code = String(code || '');
      lang = languageOf(lang);
      var fallback = [{ text: code, type: 'plain' }];
      if (!lang || !contentWithinLimit(code, 200 * 1024)) return fallback;
      var lineCount = 1;
      for (var c = 0; c < code.length; c++) if (code[c] === '\n' && ++lineCount > 3000) return fallback;
      var quoted = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y;
      var hash = /#[^\r\n]*/y, slash = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y;
      var rules = {
        js: { comment: slash, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/y,
          words: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield' },
        ts: { comment: slash, string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/y,
          words: 'abstract any as async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface keyof let namespace never new null number of private protected public readonly return static string super switch this throw true try type typeof undefined unknown var void while yield' },
        json: { string: /"(?:\\.|[^"\\])*"?/y, words: 'true false null' },
        py: { comment: hash, string: /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y,
          words: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield' },
        sh: { comment: hash, string: quoted, words: 'if then else elif fi for while do done case esac in function select until time export local readonly return' },
        ps1: { comment: /<#[\s\S]*?(?:#>|$)|#[^\r\n]*/y, string: quoted, insensitive: true,
          words: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using while workflow' },
        php: { comment: /\/\/[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, string: quoted, insensitive: true,
          words: 'abstract array as break callable case catch class clone const continue declare default do echo else elseif empty endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global if implements include include_once instanceof interface isset list namespace new null private protected public require require_once return static switch throw trait true false try unset use var while yield' },
        rust: { comment: slash, string: quoted,
          words: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while' },
        css: { comment: /\/\*[\s\S]*?(?:\*\/|$)/y, string: quoted, words: 'important inherit initial unset auto none' },
        html: { comment: /<!--[\s\S]*?(?:-->|$)/y, string: quoted, words: 'DOCTYPE doctype' },
        sql: { comment: /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, string: quoted, insensitive: true,
          words: 'select from where and or not null true false insert into values update set delete create alter drop table index join inner left right outer on as group by order having limit offset distinct union all case when then else end exists in is like between primary key references default begin commit rollback' },
        yaml: { comment: hash, string: quoted, words: 'true false null yes no on off' },
        toml: { comment: hash, string: quoted, words: 'true false inf nan' },
        md: { comment: /<!--[\s\S]*?(?:-->|$)/y, string: /`+[^`\r\n]*`*|\*\*[^*\r\n]*\*\*|__[^_\r\n]*__/y, words: '' },
        diff: { comment: /(?:^|(?<=\n))-[^\r\n]*/y, string: /(?:^|(?<=\n))\+[^\r\n]*/y, words: 'diff index' }
      };
      var rule = rules[lang], keywords = new Set(rule.words.split(' '));
      var ordered = [];
      if (rule.comment) ordered.push([rule.comment, 'comment']);
      if (rule.string) ordered.push([rule.string, 'string']);
      ordered.push([/\b(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y, 'number']);
      ordered.push([/^(?:ps1|css|html|yaml)$/.test(lang) ? /[A-Za-z_$][\w$-]*/y : /[A-Za-z_$][\w$]*/y, 'word']);
      ordered.push([/[{}()[\];,.<>:+\-*/%=!?&|^~#@\\]/y, 'punct']);
      var tokens = [], cursor = 0;
      while (cursor < code.length) {
        var text = code[cursor], type = 'plain';
        for (var r = 0; r < ordered.length; r++) {
          var re = ordered[r][0]; re.lastIndex = cursor;
          var match = re.exec(code);
          if (!match || !match[0]) continue;
          text = match[0]; type = ordered[r][1];
          if (type === 'word') {
            var word = rule.insensitive ? text.toLowerCase() : text;
            if (keywords.has(word)) type = 'keyword';
            else if (/^[A-Z][A-Za-z\d]*$/.test(text)) type = 'type';
            else {
              var after = cursor + text.length;
              while (after < code.length && /[ \t]/.test(code[after])) after++;
              type = code[after] === '(' ? 'function' : 'plain';
            }
          }
          break;
        }
        var last = tokens[tokens.length - 1];
        if (last && type === 'plain' && last.type === 'plain') last.text += text;
        else tokens.push({ text: text, type: type });
        cursor += text.length;
      }
      return tokens.length ? tokens : fallback;
    }
