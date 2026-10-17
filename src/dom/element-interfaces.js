import { constructHTMLElement } from "./custom-elements.js";

export function createElementInterface(implementation, construction = "illegal") {
  // Ordinary [[Construct]] performs the initial NewTarget.prototype lookup.
  // The HTML constructor algorithm performs its own lookup after validation.
  const interfaceObject = function () {
    if (construction === "illegal") throw new TypeError("Illegal constructor");
    return constructHTMLElement(new.target, interfaceObject, construction === "autonomous");
  };
  Object.defineProperty(interfaceObject, "name", {
    value: implementation.name.replace(/^SD/, ""),
    configurable: true,
  });
  Object.defineProperty(interfaceObject, "prototype", {
    value: implementation.prototype,
    writable: false,
  });
  Object.defineProperty(implementation.prototype, "constructor", { value: interfaceObject });
  Object.setPrototypeOf(interfaceObject, Object.getPrototypeOf(implementation));
  return interfaceObject;
}

// WebIDL interface inheritance. Tag-to-interface selection is the generated
// element-family binding; these constructors are the corresponding prototypes.
export function createAdditionalElementInterfaces(Element, HTMLElement, SVGElement) {
  const interfaces = {};
  const define = (parent, names) => {
    const html = parent === HTMLElement || Object.prototype.isPrototypeOf.call(HTMLElement.prototype, parent.prototype);
    for (const name of names.split(" ")) {
      const interfaceObject = createElementInterface(class extends parent {}, html ? "html" : "illegal");
      Object.defineProperty(interfaceObject, "name", { value: name, configurable: true });
      Object.defineProperty(interfaceObject.prototype, Symbol.toStringTag, { value: name, configurable: true });
      interfaces[name] = interfaceObject;
    }
  };
  define(Element, "MathMLElement");
  define(HTMLElement, "HTMLFencedFrameElement HTMLSelectedContentElement");
  define(HTMLElement, "HTMLAreaElement HTMLBaseElement HTMLBodyElement HTMLBRElement HTMLDataElement HTMLDetailsElement HTMLDialogElement HTMLDirectoryElement HTMLDivElement HTMLDListElement HTMLEmbedElement HTMLFontElement HTMLFrameElement HTMLFrameSetElement HTMLHeadElement HTMLHeadingElement HTMLHRElement HTMLHtmlElement HTMLLegendElement HTMLLIElement HTMLLinkElement HTMLMarqueeElement HTMLMediaElement HTMLMenuElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLObjectElement HTMLOListElement HTMLOptGroupElement HTMLParagraphElement HTMLParamElement HTMLPictureElement HTMLPreElement HTMLProgressElement HTMLQuoteElement HTMLSlotElement HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableSectionElement HTMLTimeElement HTMLTitleElement HTMLTrackElement HTMLUListElement HTMLUnknownElement");
  define(interfaces.HTMLMediaElement, "HTMLAudioElement HTMLVideoElement");
  define(SVGElement, "SVGAnimationElement SVGClipPathElement SVGComponentTransferFunctionElement SVGDescElement SVGFEBlendElement SVGFEColorMatrixElement SVGFEComponentTransferElement SVGFECompositeElement SVGFEConvolveMatrixElement SVGFEDiffuseLightingElement SVGFEDisplacementMapElement SVGFEDistantLightElement SVGFEDropShadowElement SVGFEFloodElement SVGFEGaussianBlurElement SVGFEImageElement SVGFEMergeElement SVGFEMergeNodeElement SVGFEMorphologyElement SVGFEOffsetElement SVGFEPointLightElement SVGFESpecularLightingElement SVGFESpotLightElement SVGFETileElement SVGFETurbulenceElement SVGFilterElement SVGGradientElement SVGGraphicsElement SVGMarkerElement SVGMaskElement SVGMetadataElement SVGMPathElement SVGPatternElement SVGScriptElement SVGStopElement SVGStyleElement SVGTitleElement SVGViewElement");
  define(interfaces.SVGAnimationElement, "SVGAnimateElement SVGAnimateMotionElement SVGAnimateTransformElement SVGSetElement");
  define(interfaces.SVGComponentTransferFunctionElement, "SVGFEFuncAElement SVGFEFuncBElement SVGFEFuncGElement SVGFEFuncRElement");
  define(interfaces.SVGGradientElement, "SVGLinearGradientElement SVGRadialGradientElement");
  define(interfaces.SVGGraphicsElement, "SVGAElement SVGDefsElement SVGForeignObjectElement SVGGElement SVGGeometryElement SVGImageElement SVGSVGElement SVGSwitchElement SVGSymbolElement SVGTextContentElement SVGUseElement");
  define(interfaces.SVGGeometryElement, "SVGCircleElement SVGEllipseElement SVGLineElement SVGPathElement SVGPolygonElement SVGPolylineElement SVGRectElement");
  define(interfaces.SVGTextContentElement, "SVGTextPathElement SVGTextPositioningElement");
  define(interfaces.SVGTextPositioningElement, "SVGTextElement SVGTSpanElement");
  return Object.freeze(interfaces);
}
