const path = require("path");
const fs = require("fs");
fs.existsSync = fs.existsSync || path.existsSync;
const interpret = require("interpret");
const prepareOptions = require("./prepareOptions");
const webpackConfigurationSchema = require("../schemas/webpackConfigurationSchema.json");
const validateSchema = require("webpack").validateSchema;
const WebpackOptionsValidationError = require("webpack").WebpackOptionsValidationError;

module.exports = function(...args) {
	const argv = args[1] || args[0];
	const options = [];
	// Shortcuts
	if (argv.d) {
		argv.debug = true;
		argv["output-pathinfo"] = true;
		if (!argv.devtool) {
			argv.devtool = "eval-cheap-module-source-map";
		}
		if (!argv.mode) {
			argv.mode = "development";
		}
	}
	if (argv.p) {
		argv["optimize-minimize"] = true;
		argv["define"] = []
			.concat(argv["define"] || [])
			.concat("process.env.NODE_ENV=\"production\"");
		if (!argv.mode) {
			argv.mode = "production";
		}
	}

	if (argv.output) {
		let output = argv.output;
		if (!path.isAbsolute(argv.o)) {
			output = path.resolve(process.cwd(), output);
		}
		argv["output-filename"] = path.basename(output);
		argv["output-path"] = path.dirname(output);
	}

	var configFileLoaded = false;
	var configFiles = [];
	var extensions = Object.keys(interpret.extensions).sort(function(a, b) {
		return a === ".js" ? -1 : b === ".js" ? 1 : a.length - b.length;
	});
	var defaultConfigFiles = ["webpack.config", "webpackfile"]
		.map(function(filename) {
			return extensions.map(function(ext) {
				return {
					path: path.resolve(filename + ext),
					ext: ext
				};
			});
		})
		.reduce(function(a, i) {
			return a.concat(i);
		}, []);

	let i;
	if (argv.config) {
		const getConfigExtension = function getConfigExtension(configPath) {
			for (i = extensions.length - 1; i >= 0; i--) {
				const tmpExt = extensions[i];
				if (
					configPath.indexOf(tmpExt, configPath.length - tmpExt.length) > -1
				) {
					return tmpExt;
				}
			}
			return path.extname(configPath);
		};

		const mapConfigArg = function mapConfigArg(configArg) {
			const resolvedPath = path.resolve(configArg);
			const extension = getConfigExtension(resolvedPath);
			return {
				path: resolvedPath,
				ext: extension
			};
		};

		const configArgList = Array.isArray(argv.config)
			? argv.config
			: [argv.config];
		configFiles = configArgList.map(mapConfigArg);
	} else {
		for (i = 0; i < defaultConfigFiles.length; i++) {
			const webpackConfig = defaultConfigFiles[i].path;
			if (fs.existsSync(webpackConfig)) {
				configFiles.push({
					path: webpackConfig,
					ext: defaultConfigFiles[i].ext
				});
				break;
			}
		}
	}
	if (configFiles.length > 0) {
		var registerCompiler = function registerCompiler(moduleDescriptor) {
			if (moduleDescriptor) {
				if (typeof moduleDescriptor === "string") {
					require(moduleDescriptor);
				} else if (!Array.isArray(moduleDescriptor)) {
					moduleDescriptor.register(require(moduleDescriptor.module));
				} else {
					for (var i = 0; i < moduleDescriptor.length; i++) {
						try {
							registerCompiler(moduleDescriptor[i]);
							break;
						} catch (e) {
							// do nothing
						}
					}
				}
			}
		};

		var requireConfig = function requireConfig(configPath) {
			var options = (function WEBPACK_OPTIONS() {
				if (argv.configRegister && argv.configRegister.length) {
					module.paths.unshift(
						path.resolve(process.cwd(), "node_modules"),
						process.cwd()
					);
					argv.configRegister.forEach(dep => {
						require(dep);
					});
					return require(configPath);
				} else {
					return require(configPath);
				}
			})();
			options = prepareOptions(options, argv);
			return options;
		};

		configFiles.forEach(function(file) {
			registerCompiler(interpret.extensions[file.ext]);
			options.push(requireConfig(file.path));
		});
		configFileLoaded = true;
	}

	if (!configFileLoaded) {
		return processConfiguredOptions({});
	} else if (options.length === 1) {
		return processConfiguredOptions(options[0]);
	} else {
		return processConfiguredOptions(options);
	}

	function processConfiguredOptions(options) {
		var webpackConfigurationValidationErrors = validateSchema(
			webpackConfigurationSchema,
			options
		);
		if (webpackConfigurationValidationErrors.length) {
			var error = new WebpackOptionsValidationError(
				webpackConfigurationValidationErrors
			);
			console.error(
				error.message,
				`\nReceived: ${typeof options} : ${JSON.stringify(options, null, 2)}`
			);
			process.exit(-1); // eslint-disable-line
		}

		// process Promise
		if (typeof options.then === "function") {
			return options.then(processConfiguredOptions);
		}

		// process ES6 default
		if (typeof options === "object" && typeof options.default === "object") {
			return processConfiguredOptions(options.default);
		}

		// filter multi-config by name
		if (Array.isArray(options) && argv["config-name"]) {
			var namedOptions = options.filter(function(opt) {
				return opt.name === argv["config-name"];
			});
			if (namedOptions.length === 0) {
				console.error(
					"Configuration with name '" + argv["config-name"] + "' was not found."
				);
				process.exit(-1); // eslint-disable-line
			} else if (namedOptions.length === 1) {
				return processConfiguredOptions(namedOptions[0]);
			}
			options = namedOptions;
		}

		if (Array.isArray(options)) {
			options.forEach(processOptions);
		} else {
			processOptions(options);
		}

		if (argv.context) {
			options.context = path.resolve(argv.context);
		}
		if (!options.context) {
			options.context = process.cwd();
		}

		if (argv.watch) {
			options.watch = true;
		}

		if (argv["watch-aggregate-timeout"]) {
			options.watchOptions = options.watchOptions || {};
			options.watchOptions.aggregateTimeout = +argv["watch-aggregate-timeout"];
		}

		if (typeof argv["watch-poll"] !== "undefined") {
			options.watchOptions = options.watchOptions || {};
			if (argv["watch-poll"] === "true" || argv["watch-poll"] === "")
				options.watchOptions.poll = true;
			else if (!isNaN(argv["watch-poll"]))
				options.watchOptions.poll = +argv["watch-poll"];
		}

		if (argv["watch-stdin"]) {
			options.watchOptions = options.watchOptions || {};
			options.watchOptions.stdin = true;
			options.watch = true;
		}

		return options;
	}

	function processOptions(options) {
		function ifArg(name, fn, init, finalize) {
			if (Array.isArray(argv[name])) {
				if (init) {
					init();
				}
				argv[name].forEach(fn);
				if (finalize) {
					finalize();
				}
			} else if (typeof argv[name] !== "undefined" && argv[name] !== null) {
				if (init) {
					init();
				}
				fn(argv[name], -1);
				if (finalize) {
					finalize();
				}
			}
		}

		function ifArgPair(name, fn, init, finalize) {
			ifArg(
				name,
				function(content, idx) {
					var i = content.indexOf("=");
					if (i < 0) {
						return fn(null, content, idx);
					} else {
						return fn(content.substr(0, i), content.substr(i + 1), idx);
					}
				},
				init,
				finalize
			);
		}

		function ifBooleanArg(name, fn) {
			ifArg(name, function(bool) {
				if (bool) {
					fn();
				}
			});
		}

		function mapArgToBoolean(name, optionName) {
			ifArg(name, function(bool) {
				if (bool === true) options[optionName || name] = true;
				else if (bool === false) options[optionName || name] = false;
			});
		}

		function loadPlugin(name) {
			var loadUtils = require("loader-utils");
			var args;
			try {
				var p = name && name.indexOf("?");
				if (p > -1) {
					args = loadUtils.parseQuery(name.substring(p));
					name = name.substring(0, p);
				}
			} catch (e) {
				console.log("Invalid plugin arguments " + name + " (" + e + ").");
				process.exit(-1); // eslint-disable-line
			}

			var path;
			try {
				var resolve = require("enhanced-resolve");
				path = resolve.sync(process.cwd(), name);
			} catch (e) {
				console.log("Cannot resolve plugin " + name + ".");
				process.exit(-1); // eslint-disable-line
			}
			var Plugin;
			try {
				Plugin = require(path);
			} catch (e) {
				console.log("Cannot load plugin " + name + ". (" + path + ")");
				throw e;
			}
			try {
				return new Plugin(args);
			} catch (e) {
				console.log("Cannot instantiate plugin " + name + ". (" + path + ")");
				throw e;
			}
		}

		function ensureObject(parent, name) {
			if (typeof parent[name] !== "object" || parent[name] === null) {
				parent[name] = {};
			}
		}

		function ensureArray(parent, name) {
			if (!Array.isArray(parent[name])) {
				parent[name] = [];
			}
		}

		function addPlugin(options, plugin) {
			ensureArray(options, "plugins");
			options.plugins.unshift(plugin);
		}

		ifArg("mode", function(value) {
			options.mode = value;
		});

		ifArgPair(
			"entry",
			function(name, entry) {
				if (
					typeof options.entry[name] !== "undefined" &&
					options.entry[name] !== null
				) {
					options.entry[name] = [].concat(options.entry[name]).concat(entry);
				} else {
					options.entry[name] = entry;
				}
			},
			function() {
				ensureObject(options, "entry");
			}
		);

		function bindRules(arg) {
			ifArgPair(
				arg,
				function(name, binding) {
					if (name === null) {
						name = binding;
						binding += "-loader";
					}
					var rule = {
						test: new RegExp(
							"\\." +
								name.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") +
								"$"
						), // eslint-disable-line no-useless-escape
						loader: binding
					};
					if (arg === "module-bind-pre") {
						rule.enforce = "pre";
					} else if (arg === "module-bind-post") {
						rule.enforce = "post";
					}
					options.module.rules.push(rule);
				},
				function() {
					ensureObject(options, "module");
					ensureArray(options.module, "rules");
				}
			);
		}
		bindRules("module-bind");
		bindRules("module-bind-pre");
		bindRules("module-bind-post");

		var defineObject;
		ifArgPair(
			"define",
			function(name, value) {
				if (name === null) {
					name = value;
					value = true;
				}
				defineObject[name] = value;
			},
			function() {
				defineObject = {};
			},
			function() {
				var DefinePlugin = require("webpack/lib/DefinePlugin");
				addPlugin(options, new DefinePlugin(defineObject));
			}
		);

		ifArg("output-path", function(value) {
			ensureObject(options, "output");
			options.output.path = path.resolve(value);
		});

		ifArg("output-filename", function(value) {
			ensureObject(options, "output");

			options.output.filename = value;
		});

		ifArg("output-chunk-filename", function(value) {
			ensureObject(options, "output");
			options.output.chunkFilename = value;
		});

		ifArg("output-source-map-filename", function(value) {
			ensureObject(options, "output");
			options.output.sourceMapFilename = value;
		});

		ifArg("output-public-path", function(value) {
			ensureObject(options, "output");
			options.output.publicPath = value;
		});

		ifArg("output-jsonp-function", function(value) {
			ensureObject(options, "output");
			options.output.jsonpFunction = value;
		});

		ifBooleanArg("output-pathinfo", function() {
			ensureObject(options, "output");
			options.output.pathinfo = true;
		});

		ifArg("output-library", function(value) {
			ensureObject(options, "output");
			options.output.library = value;
		});

		ifArg("output-library-target", function(value) {
			ensureObject(options, "output");
			options.output.libraryTarget = value;
		});

		ifArg("records-input-path", function(value) {
			options.recordsInputPath = path.resolve(value);
		});

		ifArg("records-output-path", function(value) {
			options.recordsOutputPath = path.resolve(value);
		});

		ifArg("records-path", function(value) {
			options.recordsPath = path.resolve(value);
		});

		ifArg("target", function(value) {
			options.target = value;
		});

		mapArgToBoolean("cache");

		ifBooleanArg("hot", function() {
			var HotModuleReplacementPlugin = require("webpack/lib/HotModuleReplacementPlugin");
			addPlugin(options, new HotModuleReplacementPlugin());
		});

		ifBooleanArg("debug", function() {
			var LoaderOptionsPlugin = require("webpack/lib/LoaderOptionsPlugin");
			addPlugin(
				options,
				new LoaderOptionsPlugin({
					debug: true
				})
			);
		});

		ifArg("devtool", function(value) {
			options.devtool = value;
		});

		function processResolveAlias(arg, key) {
			ifArgPair(arg, function(name, value) {
				if (!name) {
					throw new Error("--" + arg + " <string>=<string>");
				}
				ensureObject(options, key);
				ensureObject(options[key], "alias");
				options[key].alias[name] = value;
			});
		}
		processResolveAlias("resolve-alias", "resolve");
		processResolveAlias("resolve-loader-alias", "resolveLoader");

		ifArg("resolve-extensions", function(value) {
			ensureObject(options, "resolve");
			if (Array.isArray(value)) {
				options.resolve.extensions = value;
			} else {
				options.resolve.extensions = value.split(/,\s*/);
			}
		});

		ifArg("optimize-max-chunks", function(value) {
			var LimitChunkCountPlugin = require("webpack/lib/optimize/LimitChunkCountPlugin");
			addPlugin(
				options,
				new LimitChunkCountPlugin({
					maxChunks: parseInt(value, 10)
				})
			);
		});

		ifArg("optimize-min-chunk-size", function(value) {
			var MinChunkSizePlugin = require("webpack/lib/optimize/MinChunkSizePlugin");
			addPlugin(
				options,
				new MinChunkSizePlugin({
					minChunkSize: parseInt(value, 10)
				})
			);
		});

		ifBooleanArg("optimize-minimize", function() {
			var LoaderOptionsPlugin = require("webpack/lib/LoaderOptionsPlugin");
			addPlugin(
				options,
				new LoaderOptionsPlugin({
					minimize: true
				})
			);
		});

		ifArg("prefetch", function(request) {
			var PrefetchPlugin = require("webpack/lib/PrefetchPlugin");
			addPlugin(options, new PrefetchPlugin(request));
		});

		ifArg("provide", function(value) {
			var idx = value.indexOf("=");
			var name;
			if (idx >= 0) {
				name = value.substr(0, idx);
				value = value.substr(idx + 1);
			} else {
				name = value;
			}
			var ProvidePlugin = require("webpack/lib/ProvidePlugin");
			addPlugin(options, new ProvidePlugin(name, value));
		});

		ifArg("plugin", function(value) {
			addPlugin(options, loadPlugin(value));
		});

		mapArgToBoolean("bail");

		mapArgToBoolean("profile");

		if (argv._.length > 0) {
			if (Array.isArray(options.entry) || typeof options.entry === "string") {
				options.entry = {
					main: options.entry
				};
			}
			ensureObject(options, "entry");

			var addTo = function addTo(name, entry) {
				if (options.entry[name]) {
					if (!Array.isArray(options.entry[name])) {
						options.entry[name] = [options.entry[name]];
					}
					options.entry[name].push(entry);
				} else {
					options.entry[name] = entry;
				}
			};
			argv._.forEach(function(content) {
				var i = content.indexOf("=");
				var j = content.indexOf("?");
				if (i < 0 || (j >= 0 && j < i)) {
					var resolved = path.resolve(content);
					if (fs.existsSync(resolved)) {
						addTo(
							"main",
							`${resolved}${
								fs.statSync(resolved).isDirectory() ? path.sep : ""
							}`
						);
					} else {
						addTo("main", content);
					}
				} else {
					addTo(content.substr(0, i), content.substr(i + 1));
				}
			});
		}
	}
};
