const CONSTANTS = Object.freeze({
  ARRAY_BUFFER: 0x8892,
  BLEND: 0x0BE2,
  CLAMP_TO_EDGE: 0x812F,
  COLOR_ATTACHMENT0: 0x8CE0,
  COLOR_BUFFER_BIT: 0x4000,
  COMPILE_STATUS: 0x8B81,
  CULL_FACE: 0x0B44,
  DEPTH_TEST: 0x0B71,
  DITHER: 0x0BD0,
  DRAW_FRAMEBUFFER: 0x8CA9,
  DST_ALPHA: 0x0304,
  DYNAMIC_DRAW: 0x88E8,
  FLOAT: 0x1406,
  FRAGMENT_SHADER: 0x8B30,
  FRAMEBUFFER: 0x8D40,
  FRAMEBUFFER_COMPLETE: 0x8CD5,
  FUNC_ADD: 0x8006,
  LINEAR: 0x2601,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  LINK_STATUS: 0x8B82,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
  MAX_TEXTURE_SIZE: 0x0D33,
  MAX_VERTEX_ATTRIBS: 0x8869,
  NEAREST: 0x2600,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  NO_ERROR: 0,
  ONE: 1,
  ONE_MINUS_DST_ALPHA: 0x0307,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  PACK_ALIGNMENT: 0x0D05,
  READ_FRAMEBUFFER: 0x8CA8,
  REPEAT: 0x2901,
  RGBA: 0x1908,
  RGBA32F: 0x8814,
  RGBA8: 0x8058,
  SCISSOR_TEST: 0x0C11,
  SRC_ALPHA: 0x0302,
  STATIC_DRAW: 0x88E4,
  STENCIL_TEST: 0x0B90,
  TEXTURE0: 0x84C0,
  TEXTURE1: 0x84C1,
  TEXTURE2: 0x84C2,
  TEXTURE3: 0x84C3,
  TEXTURE6: 0x84C6,
  TEXTURE7: 0x84C7,
  TEXTURE_2D: 0x0DE1,
  TEXTURE_BASE_LEVEL: 0x813C,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MAX_LEVEL: 0x813D,
  TEXTURE_MAX_LOD: 0x813B,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MIN_LOD: 0x813A,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TRIANGLES: 0x0004,
  UNPACK_ALIGNMENT: 0x0CF5,
  UNPACK_ROW_LENGTH: 0x0CF2,
  UNSIGNED_BYTE: 0x1401,
  VERTEX_SHADER: 0x8B31,
  ZERO: 0,
});

let nativeWebgl2HostPromise = null;

export function prepareNativeWebgl2Host() {
  nativeWebgl2HostPromise ??= (async () => {
    const packageSpecifier = typeof Deno === "object"
      ? "npm:native-gles@0.6.1"
      : "native-gles";
    let imported;
    try {
      imported = await import(packageSpecifier);
    } catch (error) {
      // The package is not installed.
      if (error?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "Native WebGL 2 requires the optional native-gles dependency. Run deno task install-cli to install it.",
          { cause: error },
        );
      }
      // The package is installed and its import failed: a native library
      // that does not load, or an error of the runtime's package resolution.
      throw new Error(
        `Native WebGL 2 could not load the native-gles dependency: ${error?.message ?? error}`,
        { cause: error },
      );
    }
    const nativeGraphics = imported.default ?? imported;
    if (typeof Deno !== "object") {
      const warmupContext = nativeGraphics.createContext(1, 1);
      if (!warmupContext) {
        throw new Error(
          "native-gles could not create the warmup OpenGL ES 3 context",
        );
      }
      nativeGraphics.destroyContext(warmupContext);
    }
    return nativeGraphics;
  })();
  return nativeWebgl2HostPromise;
}

export async function createNativeWebgl2Context(width, height) {
  const nativeGraphics = await prepareNativeWebgl2Host();
  const contextIdentifier = nativeGraphics.createContext(width, height);
  if (!contextIdentifier) {
    throw new Error("native-gles could not create an OpenGL ES 3 context");
  }

  const oneIdentifier = new Uint32Array(1);
  const bytes = (value) =>
    new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
  const createIdentifier = (generate) => {
    generate(1, oneIdentifier);
    return oneIdentifier[0];
  };
  const deleteIdentifier = (remove, identifier) => {
    if (identifier === null || identifier === 0) return;
    oneIdentifier[0] = identifier;
    remove(1, oneIdentifier);
  };
  const locationCall = (location, call) => {
    if (location !== null) call(location);
  };
  const context = {
    ...CONSTANTS,
    activate() {
      if (!nativeGraphics.makeCurrent(contextIdentifier)) {
        throw new Error(
          "native-gles could not make the Sandom context current",
        );
      }
    },
    get backendInfo() {
      context.activate();
      return Object.freeze({
        host: "native-gles",
        implementation: "ANGLE",
        version: nativeGraphics.glGetString(0x1F02),
        vendor: nativeGraphics.glGetString(0x1F00),
        renderer: nativeGraphics.glGetString(0x1F01),
      });
    },
    destroy() {
      nativeGraphics.destroyContext(contextIdentifier);
    },
    finish: nativeGraphics.glFinish.bind(nativeGraphics),
    getError: nativeGraphics.glGetError.bind(nativeGraphics),
    activeTexture: nativeGraphics.glActiveTexture.bind(nativeGraphics),
    attachShader: nativeGraphics.glAttachShader.bind(nativeGraphics),
    bindBuffer(target, identifier) {
      nativeGraphics.glBindBuffer(target, identifier ?? 0);
    },
    bindFramebuffer(target, identifier) {
      nativeGraphics.glBindFramebuffer(target, identifier ?? 0);
    },
    bindTexture(target, identifier) {
      nativeGraphics.glBindTexture(target, identifier ?? 0);
    },
    bindVertexArray(identifier) {
      nativeGraphics.glBindVertexArray(identifier ?? 0);
    },
    blendEquation: nativeGraphics.glBlendEquation.bind(nativeGraphics),
    blendFunc: nativeGraphics.glBlendFunc.bind(nativeGraphics),
    blendFuncSeparate: nativeGraphics.glBlendFuncSeparate.bind(nativeGraphics),
    blitFramebuffer: nativeGraphics.glBlitFramebuffer.bind(nativeGraphics),
    bufferData(target, data, usage) {
      nativeGraphics.glBufferData(target, bytes(data), usage);
    },
    checkFramebufferStatus: nativeGraphics.glCheckFramebufferStatus.bind(
      nativeGraphics,
    ),
    clear: nativeGraphics.glClear.bind(nativeGraphics),
    clearColor: nativeGraphics.glClearColor.bind(nativeGraphics),
    compileShader: nativeGraphics.glCompileShader.bind(nativeGraphics),
    createBuffer() {
      return createIdentifier(nativeGraphics.glGenBuffers.bind(nativeGraphics));
    },
    createFramebuffer() {
      return createIdentifier(
        nativeGraphics.glGenFramebuffers.bind(nativeGraphics),
      );
    },
    createProgram: nativeGraphics.glCreateProgram.bind(nativeGraphics),
    createShader: nativeGraphics.glCreateShader.bind(nativeGraphics),
    createTexture() {
      return createIdentifier(
        nativeGraphics.glGenTextures.bind(nativeGraphics),
      );
    },
    createVertexArray() {
      return createIdentifier(
        nativeGraphics.glGenVertexArrays.bind(nativeGraphics),
      );
    },
    deleteFramebuffer(identifier) {
      deleteIdentifier(
        nativeGraphics.glDeleteFramebuffers.bind(nativeGraphics),
        identifier,
      );
    },
    deleteProgram: nativeGraphics.glDeleteProgram.bind(nativeGraphics),
    deleteShader: nativeGraphics.glDeleteShader.bind(nativeGraphics),
    deleteBuffer(identifier) {
      deleteIdentifier(
        nativeGraphics.glDeleteBuffers.bind(nativeGraphics),
        identifier,
      );
    },
    deleteTexture(identifier) {
      deleteIdentifier(
        nativeGraphics.glDeleteTextures.bind(nativeGraphics),
        identifier,
      );
    },
    disable: nativeGraphics.glDisable.bind(nativeGraphics),
    drawArrays: nativeGraphics.glDrawArrays.bind(nativeGraphics),
    drawArraysInstanced: nativeGraphics.glDrawArraysInstanced.bind(
      nativeGraphics,
    ),
    enable: nativeGraphics.glEnable.bind(nativeGraphics),
    enableVertexAttribArray: nativeGraphics.glEnableVertexAttribArray.bind(
      nativeGraphics,
    ),
    framebufferTexture2D: nativeGraphics.glFramebufferTexture2D.bind(
      nativeGraphics,
    ),
    generateMipmap: nativeGraphics.glGenerateMipmap.bind(nativeGraphics),
    deleteVertexArray(identifier) {
      deleteIdentifier(
        nativeGraphics.glDeleteVertexArrays.bind(nativeGraphics),
        identifier,
      );
    },
    getParameter(parameter) {
      return nativeGraphics.glGetIntegerv(parameter);
    },
    getProgramInfoLog: nativeGraphics.glGetProgramInfoLog.bind(nativeGraphics),
    getProgramParameter(program, parameter) {
      return nativeGraphics.glGetProgramiv(program, parameter);
    },
    getShaderInfoLog: nativeGraphics.glGetShaderInfoLog.bind(nativeGraphics),
    getShaderParameter(shader, parameter) {
      return nativeGraphics.glGetShaderiv(shader, parameter);
    },
    getUniformLocation(program, name) {
      const location = nativeGraphics.glGetUniformLocation(program, name);
      return location < 0 ? null : location;
    },
    isContextLost() {
      return !nativeGraphics.getContextInfo(contextIdentifier).valid;
    },
    linkProgram: nativeGraphics.glLinkProgram.bind(nativeGraphics),
    pixelStorei: nativeGraphics.glPixelStorei.bind(nativeGraphics),
    readPixels: nativeGraphics.glReadPixels.bind(nativeGraphics),
    scissor: nativeGraphics.glScissor.bind(nativeGraphics),
    shaderSource: nativeGraphics.glShaderSource.bind(nativeGraphics),
    texParameterf: nativeGraphics.glTexParameterf.bind(nativeGraphics),
    texParameteri: nativeGraphics.glTexParameteri.bind(nativeGraphics),
    texStorage2D: nativeGraphics.glTexStorage2D.bind(nativeGraphics),
    texSubImage2D(
      target,
      level,
      x,
      y,
      uploadWidth,
      uploadHeight,
      format,
      type,
      data,
    ) {
      nativeGraphics.glTexSubImage2D(
        target,
        level,
        x,
        y,
        uploadWidth,
        uploadHeight,
        format,
        type,
        bytes(data),
      );
    },
    uniform1f(location, value) {
      locationCall(
        location,
        (validLocation) => nativeGraphics.glUniform1f(validLocation, value),
      );
    },
    uniform1i(location, value) {
      locationCall(
        location,
        (validLocation) => nativeGraphics.glUniform1i(validLocation, value),
      );
    },
    uniform2f(location, first, second) {
      locationCall(
        location,
        (validLocation) =>
          nativeGraphics.glUniform2f(validLocation, first, second),
      );
    },
    uniform4f(location, first, second, third, fourth) {
      locationCall(location, (validLocation) =>
        nativeGraphics.glUniform4f(
          validLocation,
          first,
          second,
          third,
          fourth,
        ));
    },
    uniform4fv(location, value) {
      locationCall(
        location,
        (validLocation) => nativeGraphics.glUniform4fv(validLocation, value),
      );
    },
    useProgram: nativeGraphics.glUseProgram.bind(nativeGraphics),
    vertexAttribDivisor: nativeGraphics.glVertexAttribDivisor.bind(
      nativeGraphics,
    ),
    vertexAttribPointer: nativeGraphics.glVertexAttribPointer.bind(
      nativeGraphics,
    ),
    viewport: nativeGraphics.glViewport.bind(nativeGraphics),
  };
  context.activate();
  return Object.freeze(context);
}
