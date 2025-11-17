// src/index.ts
function defineHttpTool(options) {
  return options;
}
async function executeHttpTool(tool, input, options = {}) {
  const parsedInput = tool.inputSchema.parse(input);
  const data = await tool.handler(parsedInput, {
    headers: options.headers
  });
  const parsedOutput = tool.outputSchema.parse(data);
  return {
    data: parsedOutput,
    meta: {
      tool: tool.name,
      version: tool.version,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}
export {
  defineHttpTool,
  executeHttpTool
};
