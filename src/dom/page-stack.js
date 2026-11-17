// The coordinate space of a paged surface (design/fragmentation.md,
// section 4, "The coordinate space of a paged surface"): the page boxes of the
// document's pages lie one below the other, their left edges aligned, and
// the page area of the page shown has its origin at (0, 0), where the
// viewport of a page frame is. A point of another page lies where its page
// box lies in that stack.
//
// `pages` is a page count's page list ({ box: { height, area: { x, y } } }
// for each page, in order) and `shown` the index of the page shown.

// The offset of page `page`'s page-area origin in the space of page
// `shown`: add it to a point of page `page`'s area.
export function pageAreaOffset(pages, shown, page) {
  if (!(page >= 0 && page < pages.length)) {
    throw new RangeError(`page ${page} is not a page of the ${pages.length}-page count`);
  }
  if (!(shown >= 0 && shown < pages.length)) {
    throw new RangeError(`page ${shown} is not a page of the ${pages.length}-page count`);
  }
  let y = 0;
  for (let index = Math.min(page, shown); index < Math.max(page, shown); index++) y += pages[index].box.height;
  if (page < shown) y = -y;
  const area = pages[page].box.area;
  const shownArea = pages[shown].box.area;
  return { x: area.x - shownArea.x, y: y + area.y - shownArea.y };
}

// The page of the stacked space's point (x, y) and the point on it, from
// its page box's top left corner: { page, x, y }. A point above the first
// page box takes the first page and one below the last the last.
export function pageOfPoint(pages, shown, x, y) {
  const shownArea = pages[shown].box.area;
  // The point from the top of the first page box.
  let top = y + shownArea.y;
  for (let index = 0; index < shown; index++) top += pages[index].box.height;
  let page = 0;
  while (page < pages.length - 1 && top >= pages[page].box.height) {
    top -= pages[page].box.height;
    page++;
  }
  return { page, x: x + shownArea.x, y: top };
}

// The stacked space's point of the point (x, y) on page `page`, from its
// page box's top left corner.
export function pointOfPage(pages, shown, page, x, y) {
  const offset = pageAreaOffset(pages, shown, page);
  const area = pages[page].box.area;
  return { x: x - area.x + offset.x, y: y - area.y + offset.y };
}
