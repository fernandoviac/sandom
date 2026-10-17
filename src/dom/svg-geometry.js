// SVGGraphicsElement getBBox, getCTM and getScreenCTM, and the SVGMatrix
// and SVGRect objects they return. The core computes every value
// (src/dom-wasm/svg-graphics.watpart); these bindings convert WebIDL
// arguments and carry the values.
import { sharedDomCore } from "../dom-wasm/core.js";
import { withLiveGeometry } from "./live-geometry.js";

function outputValues(core, count) {
  const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), count * 8);
  return Array.from({ length: count }, (_, index) => view.getFloat64(index * 8, true));
}

function illegalInvocation() {
  return new TypeError("Illegal invocation");
}

// WebIDL float: a finite number rounded to single precision.
function webIDLFloat(value, name) {
  const number = +value;
  if (!Number.isFinite(number)) {
    throw new TypeError(`Failed to execute '${name}' on 'SVGMatrix': The provided float value is non-finite.`);
  }
  return Math.fround(number);
}

function requireArguments(count, required, name) {
  if (count < required) {
    throw new TypeError(`Failed to execute '${name}' on 'SVGMatrix': ${required} argument${required === 1 ? "" : "s"} required, but only ${count} present.`);
  }
}

const matrixValues = new WeakMap();

class SDSVGMatrix {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
}

function createSVGMatrix(values) {
  const matrix = Object.create(SDSVGMatrix.prototype);
  matrixValues.set(matrix, values);
  return matrix;
}

function valuesOf(matrix) {
  const values = matrixValues.get(matrix);
  if (values === undefined) throw illegalInvocation();
  return values;
}

function matrixOperation(matrix, operation, ...parameters) {
  const values = valuesOf(matrix);
  const core = sharedDomCore;
  core.status("svg_matrix_operation", operation, ...values,
    ...[0, 1, 2, 3, 4, 5].map((index) => parameters[index] ?? 0));
  return createSVGMatrix(outputValues(core, 6));
}

const MATRIX_FIELDS = ["a", "b", "c", "d", "e", "f"];
for (const [index, name] of MATRIX_FIELDS.entries()) {
  Object.defineProperty(SDSVGMatrix.prototype, name, {
    get() { return valuesOf(this)[index]; },
    set(value) { valuesOf(this)[index] = +value; },
    enumerable: true,
    configurable: true,
  });
}

const matrixMethods = {
  multiply(secondMatrix) {
    requireArguments(arguments.length, 1, "multiply");
    if (!matrixValues.has(secondMatrix)) {
      throw new TypeError("Failed to execute 'multiply' on 'SVGMatrix': parameter 1 is not of type 'SVGMatrix'.");
    }
    return matrixOperation(this, 1, ...matrixValues.get(secondMatrix));
  },
  inverse() { return matrixOperation(this, 2); },
  translate(x, y) {
    requireArguments(arguments.length, 2, "translate");
    return matrixOperation(this, 3, webIDLFloat(x, "translate"), webIDLFloat(y, "translate"));
  },
  scale(scaleFactor) {
    requireArguments(arguments.length, 1, "scale");
    return matrixOperation(this, 4, webIDLFloat(scaleFactor, "scale"));
  },
  scaleNonUniform(scaleFactorX, scaleFactorY) {
    requireArguments(arguments.length, 2, "scaleNonUniform");
    return matrixOperation(this, 5, webIDLFloat(scaleFactorX, "scaleNonUniform"), webIDLFloat(scaleFactorY, "scaleNonUniform"));
  },
  rotate(angle) {
    requireArguments(arguments.length, 1, "rotate");
    return matrixOperation(this, 6, webIDLFloat(angle, "rotate"));
  },
  rotateFromVector(x, y) {
    requireArguments(arguments.length, 2, "rotateFromVector");
    return matrixOperation(this, 7, webIDLFloat(x, "rotateFromVector"), webIDLFloat(y, "rotateFromVector"));
  },
  flipX() { return matrixOperation(this, 8); },
  flipY() { return matrixOperation(this, 9); },
  skewX(angle) {
    requireArguments(arguments.length, 1, "skewX");
    return matrixOperation(this, 10, webIDLFloat(angle, "skewX"));
  },
  skewY(angle) {
    requireArguments(arguments.length, 1, "skewY");
    return matrixOperation(this, 11, webIDLFloat(angle, "skewY"));
  },
};
// Chrome's generated binding installs the operations in name order.
for (const name of Object.keys(matrixMethods).sort()) {
  Object.defineProperty(SDSVGMatrix.prototype, name, {
    value: matrixMethods[name], writable: true, enumerable: true, configurable: true,
  });
}

const rectValues = new WeakMap();

class SDSVGRect {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
}

function createSVGRect(values) {
  const rect = Object.create(SDSVGRect.prototype);
  rectValues.set(rect, values);
  return rect;
}

for (const [index, name] of ["x", "y", "width", "height"].entries()) {
  Object.defineProperty(SDSVGRect.prototype, name, {
    get() {
      const values = rectValues.get(this);
      if (values === undefined) throw illegalInvocation();
      return values[index];
    },
    set(value) {
      const values = rectValues.get(this);
      if (values === undefined) throw illegalInvocation();
      values[index] = Math.fround(+value);
    },
    enumerable: true,
    configurable: true,
  });
}

for (const [interfaceObject, name] of [[SDSVGMatrix, "SVGMatrix"], [SDSVGRect, "SVGRect"]]) {
  Object.defineProperty(interfaceObject, "name", { value: name, configurable: true });
  // WebIDL defines the operations and attributes before constructor.
  delete interfaceObject.prototype.constructor;
  Object.defineProperty(interfaceObject.prototype, "constructor", { value: interfaceObject, writable: true, configurable: true });
  Object.defineProperty(interfaceObject.prototype, Symbol.toStringTag, { value: name, configurable: true });
}

export const SVGMatrix = SDSVGMatrix;
export const SVGRect = SDSVGRect;

function graphicsMatrix(node, options, screen) {
  return withLiveGeometry(node, options, ({ core, handle }) =>
    core.status("svg_graphics_matrix", handle, node._coreHandle, screen)
      ? createSVGMatrix(outputValues(core, 6))
      : null);
}

export const svgGraphicsRuntime = {
  getBBox(node, options) {
    return withLiveGeometry(node, options, ({ core, handle }) => {
      core.status("svg_graphics_bbox", handle, node._coreHandle);
      return createSVGRect(outputValues(core, 4).map(Math.fround));
    });
  },
  getCTM(node, options) {
    return graphicsMatrix(node, options, 0);
  },
  getScreenCTM(node, options) {
    return graphicsMatrix(node, options, 1);
  },
};
