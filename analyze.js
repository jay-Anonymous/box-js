var controller = require("./_controller");
var escodegen = require("escodegen");
var esprima = require("esprima");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

const filename = process.argv[2];

console.log(`Analyzing ${filename}`);
let code = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8") + fs.readFileSync(filename, "utf8");

if (code.match("<job") || code.match("<script")) { // The sample may actually be a .wsf, which is <job><script>..</script><script>..</script></job>.
	code = code.replace(/<\??\/?\w+( .*)*\??>/g, ""); // XML tags
	code = code.replace(/<!\[CDATA\[/g, "");
	code = code.replace(/\]\]>/g, "");
}

function rewrite(code) {
	if (code.match("@cc_on")) {
		if (process.argv.indexOf("--no-cc_on-rewrite") === -1) {
			code = code.replace(/\/\*@cc_on/g, "");
			code = code.replace(/@\*\//g, "");
		} else {
			console.log(
`The code appears to contain conditional compilation statements.
If you run into unexpected results, try uncommenting lines that look like

    /*@cc_on
    <JavaScript code>
    @*/

`
			);
		}
	}

	if (process.argv.indexOf("--no-rewrite") === -1) {
		if (process.argv.indexOf("--dumb-concat-simplify") !== -1) {
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}
		var tree;
		try {
			tree = esprima.parse(code);
		} catch (e) {
			console.log(e);
			console.log("");
			if (filename.match(/jse$/)) {
				console.log(
`This appears to be a JSE (JScript.Encode) file.
Please compile the decoder and decode it first:

cc decoder.c -o decoder
./decoder ${filename} ${filename.replace(/jse$/, "js")}

`
				);
			} else {
				console.log(
`This doesn't seem to be a JavaScript/WScript file.
If this is a JSE file (JScript.Encode), compile
decoder.c and run it on the file, like this:

cc decoder.c -o decoder
./decoder ${filename} ${filename}.js

`
				);
			}
			process.exit(-1);
			return;
		}
		if (process.argv.indexOf("--no-concat-simplify") === -1) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "BinaryExpression") return;
				if (val.operator !== "+") return;
				if (val.left.type !== "Literal") return;
				if (val.right.type !== "Literal") return;
				let result = val.left.value + val.right.value;
				return {
					type: "Literal",
					value: result,
					raw: JSON.stringify(result)
				};
			});
		}
		if (process.argv.indexOf("--function-rewrite") !== -1) {
			traverse(tree, function(key, val) {
				if (key !== "callee") return;
				if (val.autogenerated) return;
				switch (val.type) {
					case "MemberExpression":
						return require("./patches/this.js")(val.object, val);
					default:
						return require("./patches/nothis.js")(val);
				}
			});
		}

		if (process.argv.indexOf("--no-typeof-rewrite") === -1) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "UnaryExpression") return;
				if (val.operator !== "typeof") return;
				if (val.autogenerated) return;
				return require("./patches/typeof.js")(val.argument);
			});
		}

		if (process.argv.indexOf("--no-eval-rewrite") === -1) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "CallExpression") return;
				if (val.callee.type !== "Identifier") return;
				if (val.callee.name !== "eval") return;
				return require("./patches/eval.js")(val.arguments);
			});
		}

		// Replace (a !== b) with (false)
		if (process.argv.indexOf("--experimental-neq") !== -1) {
			traverse(tree, function(key, val) {
				if (!val) return;
				if (val.type !== "BinaryExpression") return;
				if (val.operator !== "!=" && val.operator !== "!==") return;
				return {
					type: "Literal",
					value: false,
					raw: "false"
				};
			});
		}
		// console.log(JSON.stringify(tree, null, "\t"));
		code = escodegen.generate(tree);

		// The modifications may have resulted in more concatenations, eg. "a" + ("foo", "b") + "c" -> "a" + "b" + "c"
		if (process.argv.indexOf("--dumb-concat-simplify") !== -1) {
			code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
			code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
		}
	}
	return code;
}
code = rewrite(code);
controller.logJS(code);

Date.prototype.getYear = function() {
	return new Date().getFullYear();
};

Array.prototype.Count = function() { return this.length; }

var sandbox = {
	Date,
	rewrite: code => rewrite(controller.logJS(code)),
	_typeof: x => x.typeof ? x.typeof : typeof x,
	console: {
		log: x => console.log(JSON.stringify(x))
	},
	alert: x => {},
	parse: x => {},
	JSON: JSON,
	location: new Proxy({
		href: "http://www.foobar.com/",
		protocol: "http:",
		host: "www.foobar.com",
		hostname: "www.foobar.com"
	}, {
		get: function(target, name) {
			switch (name) {
				case Symbol.toPrimitive:
					return () => "http://www.foobar.com/";
				default:
					return target[name.toLowerCase()];
			}
		}
	}),
	WScript: new Proxy({}, {
		get: function(target, name) {
			switch (name) {
				case Symbol.toPrimitive:
					return () => "Windows Script Host";
				case "toString":
					return "Windows Script Host";

				case "Path":
					return "C:\\TestFolder\\";
				case "StdIn":
					return new Proxy({
						AtEndOfStream: {
							typeof: "unknown"
						},
						Line: 1
					}, {
						get: function(target, name) {
							if (!(name in target))
								controller.kill(`WScript.StdIn.${name} not implemented!`);
							return target[name];
						}
					});
				case "Arguments":
					return new Proxy(n => `${n}th argument`, {
						get: function(target, name) {
							switch (name) {
								case "Unnamed":
									return [];
								case "length":
									return 0;
								case "ShowUsage":
									return {
										typeof: "unknown"
									};
								case "Named":
									return [];
								default:
									return new Proxy(
										target[name],
										{
											get: (target, name) => name.toLowerCase() === "typeof" ? "unknown" : target[name]
										}
									);
							}
						}
					});
				case "CreateObject":
					return ActiveXObject;
				case "Sleep":
					// return x => console.log(`Sleeping for ${x} ms...`)
					return x => {};
				case "Quit":
					return () => {};
				case "ScriptFullName":
					return "(ScriptFullName)";
				case "Echo":
				case "echo":
					if (process.argv.indexOf("--no-echo") !== -1)
						return () => {};
					return x => {
						console.log("Script wrote:", x);
						console.log("Add flag --no-echo to disable this.");
					};
				default:
					controller.kill(`WScript.${name} not implemented!`);
			}
		}
	}),
	ActiveXObject
};

vm.runInNewContext(code, sandbox, {
	displayErrors: true,
	lineOffset: -7,
	filename: "sample.js"
});

function ActiveXObject(name) {
	// console.log(`New ActiveXObject: ${name}`);
	name = name.toLowerCase();
	if (name.match("winhttprequest"))
		return require("./_emulator/XMLHTTP")();
	if (name.match("dom")) {
		return {
			createElement: require("./_emulator/DOM"),
			load: filename => {
				// console.log(`Loading ${filename} in a virtual DOM environment...`);
			}
		};
	}

	switch (name) {
		case "adodb.stream":
			return require("./_emulator/ADODBStream")();
		case "adodb.recordset":
			return require("./_emulator/ADODBRecordSet")();
		case "msxml2.xmlhttp":
			return require("./_emulator/XMLHTTP")();
		case "scripting.filesystemobject":
			return require("./_emulator/FileSystemObject")();
		case "scripting.dictionary":
			return require("./_emulator/Dictionary")();
		case "shell.application":
			return require("./_emulator/ShellApplication")();
		case "wscript.network":
			return require("./_emulator/WScriptNetwork")();
		case "wscript.shell":
			return require("./_emulator/WScriptShell")();
		default:
			controller.kill(`Unknown ActiveXObject ${name}`);
			break;
	}
}

function traverse(obj, func) {
	var keys = Object.keys(obj);
	for (let i = 0; i < keys.length; i++) {
		let key = keys[i];
		var replacement = func.apply(this, [key, obj[key]]);
		if (replacement) obj[key] = replacement;
		if (obj.autogenerated) continue;
		if (obj[key] !== null && typeof obj[key] === "object")
			traverse(obj[key], func);
	}
}
