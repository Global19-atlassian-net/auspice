/* eslint-disable no-loop-func */
import _map from "lodash/map";
import _minBy from "lodash/minBy";
import { interpolateNumber } from "d3-interpolate";
import { averageColorsDict } from "../../util/colorHelpers";
import { bezier } from "./transmissionBezier";
import { NODE_NOT_VISIBLE } from "../../util/globals";
import { getTraitFromNode } from "../../util/treeMiscHelpers";
import { pie } from "d3-shape";

/* global L */
// L is global in scope and placed by leaflet()

// longs of original map are -180 to 180
// longs of fully triplicated map are -540 to 540
// restrict to longs between -360 to 360
const westBound = -360;
const eastBound = 360;

// interchange. this is a leaflet method that will tell d3 where to draw.
const leafletLatLongToLayerPoint = (lat, long, map) => {
  return map.latLngToLayerPoint(new L.LatLng(lat, long));
};

/* if transmission pair is legal, return a leaflet LatLng origin / dest pair
otherwise return null */
const maybeGetTransmissionPair = (latOrig, longOrig, latDest, longDest, map) => {

  // if either origin or destination are inside bounds, include
  // transmission must be less than 180 lat difference
  let pair = null;
  if (
    (longOrig > westBound || longDest > westBound) &&
    (longOrig < eastBound || longDest < eastBound) &&
    (Math.abs(longOrig - longDest) < 180)
  ) {
    pair = [
      leafletLatLongToLayerPoint(latOrig, longOrig, map),
      leafletLatLongToLayerPoint(latDest, longDest, map)
    ];
  }

  return pair;

};

/**
 * Traverses the tips of the tree to create a dict of 
 * demes -> dict of colours present across the tips.
 * The values of the nested dict are a dict with 2 keys:
 * `nVisible`: num tips w. this colour visible in current view
 * `nTotal`: total num of tips w. this colour, visible or not.
 * E.g:
 * demeToColorMap["new_zealand"]["#A3A3A3"].nVisible = 10
 *                                         .nTotal = 20
 */
const getColorsForAllDemes = (nodes, visibility, geoResolution, nodeColors) => {
  const demeToColorMap = {};
  nodes.forEach((n, i) => {
    if (n.children) return; /* demes only count terminal nodes */
    const location = getTraitFromNode(n, geoResolution);
    if (!location) return; /* ignore undefined locations */
    if (!demeToColorMap[location]) demeToColorMap[location] = {};
    const color = nodeColors[i];
    if (!demeToColorMap[location][color]) {
      demeToColorMap[location][color] = {nVisible: 0, nTotal: 0};
    }
    demeToColorMap[location][color].nTotal++;
    if (visibility[i] !== NODE_NOT_VISIBLE) {
      demeToColorMap[location][color].nVisible++;
    }
  });
  return demeToColorMap;
};

const setupDemeData = (nodes, visibility, geoResolution, nodeColors, triplicate, metadata, map, pieChart) => {

  const demeData = []; /* deme array */
  const demeIndices = {}; /* map of name to indices in array */

  const demeToColorMap = getColorsForAllDemes(nodes, visibility, geoResolution, nodeColors);

  const offsets = triplicate ? [-360, 0, 360] : [0];
  const geo = metadata.geographicInfo;

  let index = 0;
  offsets.forEach((OFFSET) => {
    /* count DEMES */
    for (const [location, colorCounts] of Object.entries(demeToColorMap)) {
      let lat = 0;
      let long = 0;
      let goodDeme = true;

      if (geo[geoResolution][location]) {
        lat = geo[geoResolution][location].latitude;
        long = geo[geoResolution][location].longitude + OFFSET;
      } else {
        goodDeme = false;
        console.warn("Warning: Lat/long missing from metadata for", location);
      }

      /* get pixel coordinates. `coords`: <Point> with properties `x` & `y` */
      const coords = leafletLatLongToLayerPoint(lat, long, map);

      // calculate total number of data points in deme
      const colors = Object.keys(colorCounts);
      const nVisibleTipsInDeme = colors.reduce((acc, cv) => acc + colorCounts[cv].nVisible, 0);

      /* add entries to
       * (1) `demeIndicies` -- a dict of "deme value" to the indicies of `demeData` & `arcData` where they appear
       * (2) `demeData` -- an array of objects, each with {name, count etc.}
       *      if pie charts, then `demeData.arcs` exists, if colour-blended circles, `demeData.color` exists
       */
      if (long > westBound && long < eastBound && goodDeme === true) {
        const demeDataIdx = demeData.length; // idx which `deme` will be inserted at

        /* base deme information used for pie charts & color-blended circles */
        const deme = {
          name: location,
          count: nVisibleTipsInDeme,
          latitude: lat, // raw latitude value
          longitude: long, // raw longitude value
          coords: coords // coords are x,y plotted via d3
        };

        if (pieChart) {
          /* arcs is the data for a single pie chart -- an array of objects each representing a "slice"
          * https://github.com/d3/d3-shape#_pie
          */
          const arcs = pie()(colors.map((c) => colorCounts[c].nVisible));
          /* add in some more info to each "slice" (i.e. each arc in arcs) */
          for (let i=0; i<arcs.length; i++) {
            arcs[i].color = colors[i];
            arcs[i].innerRadius = 0.0;
            arcs[i].demeDataIdx = demeDataIdx;
          }
          deme.arcs = arcs;
        } else {
          /* average out the constituent colours for a blended-colour circle */
          deme.color = averageColorsDict(colorCounts);
        }

        demeData.push(deme);
        if (!demeIndices[location]) {
          demeIndices[location] = [index];
        } else {
          demeIndices[location].push(index);
        }
        index += 1;
      }

    }
  });

  return {
    demeData: demeData,
    demeIndices: demeIndices
  };
};

const constructBcurve = (
  originLatLongPair,
  destinationLatLongPair,
  extend
) => {
  return bezier(originLatLongPair, destinationLatLongPair, extend);
};

const maybeConstructTransmissionEvent = (
  node,
  child,
  metadataGeoLookupTable,
  geoResolution,
  nodeColors,
  visibility,
  map,
  offsetOrig,
  offsetDest,
  demesMissingLatLongs,
  extend
) => {
  let latOrig, longOrig, latDest, longDest;
  let transmission;
  /* checking metadata for lat longs name match - ie., does the metadata list a latlong for Thailand? */
  const nodeLocation = getTraitFromNode(node, geoResolution); //  we're looking this up in the metadata lookup table
  const childLocation = getTraitFromNode(child, geoResolution);
  try {
    latOrig = metadataGeoLookupTable[geoResolution][nodeLocation].latitude;
    longOrig = metadataGeoLookupTable[geoResolution][nodeLocation].longitude;
  } catch (e) {
    demesMissingLatLongs.add(nodeLocation);
  }
  try {
    latDest = metadataGeoLookupTable[geoResolution][childLocation].latitude;
    longDest = metadataGeoLookupTable[geoResolution][childLocation].longitude;
  } catch (e) {
    demesMissingLatLongs.add(childLocation);
  }

  const validLatLongPair = maybeGetTransmissionPair(
    latOrig,
    longOrig + offsetOrig,
    latDest,
    longDest + offsetDest,
    map
  );

  if (validLatLongPair) {

    const Bcurve = constructBcurve(validLatLongPair[0], validLatLongPair[1], extend);

    /* set up interpolator with origin and destination numdates */
    const interpolator = interpolateNumber(node.num_date.value, child.num_date.value);

    /* make a Bdates array as long as Bcurve */
    const Bdates = [];
    Bcurve.forEach((d, i) => {
      /* fill it with interpolated dates */
      Bdates.push(
        interpolator(i / (Bcurve.length - 1)) /* ie., 5 / 15ths of the way through = 2016.3243 */
      );
    });

    /* build up transmissions object */
    transmission = {
      id: node.arrayIdx.toString() + "-" + child.arrayIdx.toString(),
      originNode: node,
      destinationNode: child,
      bezierCurve: Bcurve,
      bezierDates: Bdates,
      originName: getTraitFromNode(node, geoResolution),
      destinationName: getTraitFromNode(child, geoResolution),
      originCoords: validLatLongPair[0], // after interchange
      destinationCoords: validLatLongPair[1], // after interchange
      originLatitude: latOrig, // raw latitude value
      destinationLatitude: latDest, // raw latitude value
      originLongitude: longOrig + offsetOrig, // raw longitude value
      destinationLongitude: longDest + offsetDest, // raw longitude value
      originNumDate: node.num_date.value,
      destinationNumDate: child.num_date.value,
      color: nodeColors[node.arrayIdx],
      visible: visibility[child.arrayIdx] !== NODE_NOT_VISIBLE ? "visible" : "hidden", // transmission visible if child is visible
      extend: extend
    };
  }
  return transmission;
};

const maybeGetClosestTransmissionEvent = (
  node,
  child,
  metadataGeoLookupTable,
  geoResolution,
  nodeColors,
  visibility,
  map,
  offsetOrig,
  demesMissingLatLongs,
  extend
) => {
  const possibleEvents = [];
  // iterate over offsets applied to transmission destination
  // even if map is not tripled - ie., don't let a line go across the whole world
  [-360, 0, 360].forEach((offsetDest) => {
    const t = maybeConstructTransmissionEvent(
      node,
      child,
      metadataGeoLookupTable,
      geoResolution,
      nodeColors,
      visibility,
      map,
      offsetOrig,
      offsetDest,
      demesMissingLatLongs,
      extend
    );
    if (t) { possibleEvents.push(t); }
  });

  if (possibleEvents.length > 0) {

    const closestEvent = _minBy(possibleEvents, (event) => {
      return Math.abs(event.destinationCoords.x - event.originCoords.x);
    });
    return closestEvent;

  }

  return null;

};

const setupTransmissionData = (
  nodes,
  visibility,
  geoResolution,
  nodeColors,
  triplicate,
  metadata,
  map
) => {

  const offsets = triplicate ? [-360, 0, 360] : [0];
  const metadataGeoLookupTable = metadata.geographicInfo;
  const transmissionData = []; /* edges, animation paths */
  const transmissionIndices = {}; /* map of transmission id to array of indices */
  const demesMissingLatLongs = new Set();
  const demeToDemeCounts = {};
  nodes.forEach((n) => {
    const nodeDeme = getTraitFromNode(n, geoResolution);
    if (n.children) {
      n.children.forEach((child) => {
        const childDeme = getTraitFromNode(child, geoResolution);
        if (nodeDeme && childDeme && nodeDeme !== childDeme) {
          // record transmission event
          if ([nodeDeme, childDeme] in demeToDemeCounts) {
            demeToDemeCounts[[nodeDeme, childDeme]] += 1;
          } else {
            demeToDemeCounts[[nodeDeme, childDeme]] = 1;
          }
          const extend = demeToDemeCounts[[nodeDeme, childDeme]];
          // offset is applied to transmission origin
          offsets.forEach((offsetOrig) => {
            const t = maybeGetClosestTransmissionEvent(
              n,
              child,
              metadataGeoLookupTable,
              geoResolution,
              nodeColors,
              visibility,
              map,
              offsetOrig,
              demesMissingLatLongs,
              extend
            );
            if (t) { transmissionData.push(t); }
          });
        }
      });
    }
  });

  transmissionData.forEach((transmission, index) => {
    if (!transmissionIndices[transmission.id]) {
      transmissionIndices[transmission.id] = [index];
    } else {
      transmissionIndices[transmission.id].push(index);
    }
  });
  return {
    transmissionData: transmissionData,
    transmissionIndices: transmissionIndices,
    demesMissingLatLongs
  };
};

export const createDemeAndTransmissionData = (
  nodes,
  visibility,
  geoResolution,
  nodeColors,
  triplicate,
  metadata,
  map,
  pieChart
) => {

  /*
    walk through nodes and collect all data
    for demeData we have:
      name, coords, count, color
    for transmissionData we have:
      originNode, destinationNode, originCoords, destinationCoords, originName, destinationName
      originNumDate, destinationNumDate, color, visible
  */
  const {
    demeData,
    demeIndices
  } = setupDemeData(nodes, visibility, geoResolution, nodeColors, triplicate, metadata, map, pieChart);

  /* second time so that we can get Bezier */
  const { transmissionData, transmissionIndices, demesMissingLatLongs } = setupTransmissionData(
    nodes,
    visibility,
    geoResolution,
    nodeColors,
    triplicate,
    metadata,
    map
  );

  return {
    demeData: demeData,
    transmissionData: transmissionData,
    demeIndices: demeIndices,
    transmissionIndices: transmissionIndices,
    demesMissingLatLongs
  };
};

/* ******************************
********************************
UPDATE DEMES & TRANSMISSIONS
********************************
******************************* */

const updateDemeDataColAndVis = (demeData, demeIndices, nodes, visibility, geoResolution, nodeColors, pieChart) => {
  const demeDataCopy = demeData.slice();

  const demeToColorMap = getColorsForAllDemes(nodes, visibility, geoResolution, nodeColors);

  // update demeData, for each deme, update all elements via demeIndices lookup
  for (const [location, colorCounts] of Object.entries(demeToColorMap)) {
    const nVisibleTipsInDeme = Object.keys(colorCounts)
      .reduce((acc, cv) => acc + colorCounts[cv].nVisible, 0);

    demeIndices[location].forEach((index) => {
      /* both pie charts & circles need new counts (which modify the radius) */
      demeDataCopy[index].count = nVisibleTipsInDeme;
      if (pieChart) {
        /* pie charts require updating the arcs which make up the pie chart */
        const totalNumVisible = Object.keys(colorCounts).reduce((acc, cv) => acc+colorCounts[cv].nVisible, 0);
        const colors = Object.keys(colorCounts);
        let startAngle = 0.0;
        demeDataCopy[index].arcs.forEach((a, i) => {
          if (a.color !== colors[i]) {
            /* TODO - remove before merge into v2 */
            console.error("COLOR MISMATCH FATAL");
          }
          a.startAngle = startAngle;
          startAngle += 2*Math.PI*colorCounts[colors[i]].nVisible/totalNumVisible;
          a.endAngle = startAngle;
        });
      } else {
        /* circle demes just require a colour update */
        demeDataCopy[index].color = averageColorsDict(colorCounts);
      }
    });
  }

  return demeDataCopy;
};

const updateTransmissionDataColAndVis = (transmissionData, transmissionIndices, nodes, visibility, geoResolution, nodeColors) => {
  const transmissionDataCopy = transmissionData.slice(); /* basically, instead of _.map() since we're not mapping over the data we're mutating */
  nodes.forEach((node) => {
    if (node.children) {
      node.children.forEach((child) => {
        const nodeLocation = getTraitFromNode(node, geoResolution);
        const childLocation = getTraitFromNode(node, geoResolution);
        if (nodeLocation && childLocation && nodeLocation !== childLocation) {
          // this is a transmission event from n to child
          const id = node.arrayIdx.toString() + "-" + child.arrayIdx.toString();
          const col = nodeColors[node.arrayIdx];
          const vis = visibility[child.arrayIdx] !== NODE_NOT_VISIBLE ? "visible" : "hidden"; // transmission visible if child is visible

          // update transmissionData via index lookup
          try {
            transmissionIndices[id].forEach((index) => {
              transmissionDataCopy[index].color = col;
              transmissionDataCopy[index].visible = vis;
            });
          } catch (err) {
            console.warn(`Error trying to access ${id} in transmissionIndices. Map transmissions may be wrong.`);
          }
        }
      });
    }
  });
  return transmissionDataCopy;
};

export const updateDemeAndTransmissionDataColAndVis = (demeData, transmissionData, demeIndices, transmissionIndices, nodes, visibility, geoResolution, nodeColors, pieChart) => {
  /*
    walk through nodes and update attributes that can mutate
    for demeData we have:
      count, color
    for transmissionData we have:
      color, visible
  */

  let newDemes;
  let newTransmissions;

  if (demeData && transmissionData) {
    newDemes = updateDemeDataColAndVis(demeData, demeIndices, nodes, visibility, geoResolution, nodeColors, pieChart);
    newTransmissions = updateTransmissionDataColAndVis(transmissionData, transmissionIndices, nodes, visibility, geoResolution, nodeColors);
  }
  return {newDemes, newTransmissions};
};

/* ********************
**********************
ZOOM LEVEL CHANGE
**********************
********************* */

const updateDemeDataLatLong = (demeData, map) => {

  // interchange for all demes
  return _map(demeData, (d) => {
    d.coords = leafletLatLongToLayerPoint(d.latitude, d.longitude, map);
    return d;
  });

};

const updateTransmissionDataLatLong = (transmissionData, map) => {

  const transmissionDataCopy = transmissionData.slice(); /* basically, instead of _.map() since we're not mapping over the data we're mutating */

  // interchange for all transmissions
  transmissionDataCopy.forEach((transmission) => {
    transmission.originCoords = leafletLatLongToLayerPoint(transmission.originLatitude, transmission.originLongitude, map);
    transmission.destinationCoords = leafletLatLongToLayerPoint(transmission.destinationLatitude, transmission.destinationLongitude, map);
    transmission.bezierCurve = constructBcurve(
      transmission.originCoords,
      transmission.destinationCoords,
      transmission.extend
    );
  });

  return transmissionDataCopy;

};

export const updateDemeAndTransmissionDataLatLong = (demeData, transmissionData, map) => {

  /*
    walk through nodes and update attributes that can mutate
    for demeData we have:
      count, color
    for transmissionData we have:
      color, visible
  */

  let newDemes;
  let newTransmissions;

  if (demeData && transmissionData) {
    newDemes = updateDemeDataLatLong(demeData, map);
    newTransmissions = updateTransmissionDataLatLong(transmissionData, map);
  }

  return {
    newDemes,
    newTransmissions
  };
};
