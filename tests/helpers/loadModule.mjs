// 测试用的模块加载器：读 .ts 源码 → typescript 转 CommonJS → node:vm 执行 → 交出 exports。
// 沿用 plugin-sample 的手法，好处是 src/*.ts 不需要额外维护构建产物就能被单测直接引用。
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("typescript");

// 仓库根目录：tests/helpers/ 的上两级
const REPO_ROOT = new URL("../../", import.meta.url);

/**
 * 载入一个 TypeScript 源文件并返回其 exports。
 *
 * @param {string} relativePath 相对于仓库根的路径，例如 "src/model.ts"
 * @param {{dependencies?: Record<string, unknown>, globals?: Record<string, unknown>}} [options]
 *   dependencies 注入依赖桩（如 "siyuan" 模块）；globals 注入额外沙箱全局（如 window、document）
 * @returns {Record<string, unknown>} transpile 之后的模块 exports
 */
export const loadModule = (relativePath, options = {}) => {
    const relative = String(relativePath).replace(/^[\\/]+/, "");
    const filename = fileURLToPath(new URL(relative, REPO_ROOT));
    const source = readFileSync(filename, "utf8");
    // transpileModule 只做类型擦除，不做类型检查；类型检查由 `tsc --noEmit` 负责
    const {outputText} = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    });

    const dependencies = options.dependencies ?? {};
    const loadedModule = {exports: {}};
    const context = {
        module: loadedModule,
        exports: loadedModule.exports,
        require: (name) => {
            if (Object.prototype.hasOwnProperty.call(dependencies, name)) {
                return dependencies[name];
            }
            if (name.startsWith("node:")) {
                return nodeRequire(name);
            }
            // 未注入桩就放行真实模块，会在第三方包的浏览器环境代码里炸出难以定位的错误
            throw new Error(`loadModule: 模块 ${name} 没有桩实现，请通过 options.dependencies 传入`);
        },
        __filename: filename,
        __dirname: path.dirname(filename),
        console,
        ...options.globals,
    };
    vm.createContext(context);
    vm.runInNewContext(outputText, context, {filename});
    return loadedModule.exports;
};

/**
 * 把跨 realm 边界传回的纯数据搬回宿主 realm。
 *
 * runInNewContext 建的是另一个 realm，里面造出来的对象带着另一套原型，
 * assert.deepStrictEqual 会因为原型不一致而直接判不等。结构化克隆正好做一次换 realm 的搬运，
 * 搬完之后断言仍然是严格的（0 与 true 依旧判不等）。
 *
 * 只适用于纯数据：含函数、DOM 节点或 class 实例的值会克隆失败或丢失原型，此时不应使用。
 */
export const toHost = (value) => (typeof value === "object" && value !== null ? structuredClone(value) : value);
