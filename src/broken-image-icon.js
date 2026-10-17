// Chromium's broken image icon (IDR_BROKENIMAGE): the 14 by 16 icon
// (third_party/blink/public/default_100_percent/blink/broken_image.png)
// and its 28 by 32 version for a device pixel ratio of 2 or more
// (default_200_percent), which Blink's LayoutImageResource::BrokenImage
// selects. Chrome paints it at the start of the alternative text of an img
// or an image input (scene-build.watpart $sceneImageFallback).
// Provenance and license: docs/legal/images.md.
const BROKEN_IMAGE_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAA4AAAAQCAYAAAAmlE46AAABh0lEQVQoU42QSS9DURiGv7VfhKWE" +
  "nyA2WFizsLciJGrowDVU55VIjE3sxFhB1ZDiVlUapYYguLRor9f5DrdRuaJv8izOOc+zORQIBFAK" +
  "RFRGP+f3B6BlP/CYMecpo0NRFLBXFPt8fpzf6ThO50xJ3rzLkMduIfZ6vTi51hE5fZMYM85q6rUQ" +
  "8tiXsdvtQfxKx3biFb/Hd0citNlsRXBDLpdbhmbbimcRiWu4uMvhXstL+D+4IadzDPFLHRvHL6aE" +
  "TzLYT2ZxcPZF6lYHNzQ66kQsnUdIfS4Jdrmh4eERqOKwdqiVBLuiIVKUIagXeaxEtQLL0UfMRKII" +
  "7sSK7hnhckM0OKjgSISLew8ST2getePlqJuskDTPNWI2rBrvJFxuiByOARye57Gw+wDbklfIlYXI" +
  "oH6yChObERIOCVc2ZLc7ZOhaDZpG31DDVDXNhRMcghuyWu1YT6TROF3zZ2TQEmxCNPUObqi/34q2" +
  "hdZ/I+Oud60HvdY+UGdnF9rbO8ygHxS9dVss+AQqZY47NSC2iwAAAABJRU5ErkJggg==";
const BROKEN_IMAGE_ICON_2X_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABwAAAAgCAYAAAABtRhCAAAC8UlEQVR4Xr2Wy2sTURSHf3cySdpa" +
  "ay3iC8GuxO4UuxBxJ6IrFwUFddXUin9Fu3HhwoWoILZNi0qVqhhwYSmKpSoWaaUPURR8lBYfbU3S" +
  "psk0mUzmmByZDsOdobZJ/OBwuZMh3/zOnEsiurrChBKSzWYbm86efwsPWHjiZDNMKs6rCIGBx71I" +
  "JpMAhKdUJSKkMoRMtjhh0A+mpeUcwuGu0Ue9HY1NZ1olqcptyBGWdbO4hIrCq0N6t1OSKkQE4g0V" +
  "VQTG2uelLQCoID0gJbR0JYal4XDYkZQTso1Iqs1VAg07/di3O1BYeQ8ijwJDRI4KhUIrSYnAQ2P5" +
  "HNRuUFC/1Q+LioDgPc1mEU/J75uslSDR3BxCT0/3aOReZ6MKjxt3bFbhxvb89VhShwt8JPJfDC+E" +
  "EKOcsIC1bqriZPCrAm5UBgRqKgUWNWfKTMbA4WOn858rcMOv+vAkcge2ELzKMhm+Z3wqDQvraKm+" +
  "IJZzHun8AQ7FQhBY17AryLJVEfJU5yhfBsELv0q2kDHZuiq6QZia1fn+tcJCgD3sez+dRrkgMNI7" +
  "LCd2S9lJ5ZbZQsv+PxKKFaFZfp/4ny0VUkvNfzIS4voMNCOGoK8adYF6KEJdVeZ6LEAmvMiYKUzG" +
  "I/iQ6GeZRVCpxt6ao9hfdwqVvlpXmeexMD1809oIhuauQMvFXB4kiYmFCD4mnuLQlgvYs/GIUyYP" +
  "jf176MZYvA/9P9slmZt4cO4yhqMdAMhVBmIhcULihE7rm1g3JhcfYi1M5tMSQRysa3X12QkZWqnx" +
  "hfssWwfi3WIEn5YGWGEXS8BCOMG31CuMxG+tS2ZtXkdvYsn45ZwXt6FJGD/w4vdVALReGWNQGi/n" +
  "r+P4tosOmaOlOTOL5/OXoJupImQ239Nj9Dk5WJBwSS2dSDxAVP9SrMzRxpGFHp5gAjn/CEfTM3lh" +
  "XylljJaLYjh+w7poJ3w2cw0mGSWU2XxNDWFcuw09p/FetLW1k6ZpJZbJkCBUVAXwB5+6DFY4hTPh" +
  "AAAAAElFTkSuQmCC";

const decode = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
export const BROKEN_IMAGE_ICON_PNG = decode(BROKEN_IMAGE_ICON_BASE64);
export const BROKEN_IMAGE_ICON_2X_PNG = decode(BROKEN_IMAGE_ICON_2X_BASE64);
