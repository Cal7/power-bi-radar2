﻿/*
 *  Power BI Visual CLI
 *
 *  Copyright (c) Microsoft Corporation
 *  All rights reserved.
 *  MIT License
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the ""Software""), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 */

module powerbi.extensibility.visual {
    "use strict";

    //Get lodash working... Hacky solution from https://community.powerbi.com/t5/Developer/Adding-a-static-js-script-to-a-custom-visualization/td-p/104957
    let _ = (<any>window)._;

    export class Visual implements IVisual {
        private updateCount: number;
        private settings: VisualSettings;
        private target: d3.Selection<HTMLElement>;
        private leftSidebar: d3.Selection<HTMLElement>;
        private svg: d3.Selection<SVGElement>;
        private rightSidebar: d3.Selection<HTMLElement>;
        private radar: Radar;

        constructor(options: VisualConstructorOptions) {
            this.target = d3.select(options.element).append("div")
                .attr("id", "target"); //We need to create our own target element as the provided one cannot be selected via CSS
            this.leftSidebar = this.target.append("section")
                .attr("id", "left-sidebar");
            this.svg = this.target.append("section")
                .attr("id", "main")
                .append("svg")
                .attr("viewBox", "0 0 100 100") as any;
            this.rightSidebar = this.target.append("section")
                .attr("id", "right-sidebar");
            this.updateCount = 0;
        }

        /**
         * Transforms the data inside a data view into a form that's necessary to work with
         * @param data
         */
        private transformData(dataView) {
            let self = this;
            let table = dataView.table;
            let radar = new Radar();

            //ringMap will hold all the rings, indexed by their name
            //Maybe at a later date these will be defined in the data instead of hardcoded
            let ringMap = {
                Accelerate: new Ring("Accelerate", 1, "#C7C7C7"),
                Progress: new Ring("Progress", 2, "#A3A3A3"),
                Monitor: new Ring("Monitor", 3, "#7A7A7A"),
                Pause: new Ring("Pause", 4, "#525252")
            };

            //Because the order of the columns is not guaranteed to remain consistent, we need to determine the indices of all the fields before we can fetch their values
            let columnMap = table.columns.map(function (column) {
                return Object.keys(column.roles)[0];
            });
            let nameIndex = columnMap.indexOf("name");
            let descriptionIndex = columnMap.indexOf("description");
            let sectorIndex = columnMap.indexOf("sector");
            let ringIndex = columnMap.indexOf("ring");
            let isNewIndex = columnMap.indexOf("isNew");

            //Sort the rows by ring, using ringMap to determine how the rings should be compared.
            //i.e. places all accelerate rings first, then progress, etc.
            table.rows = _.sortBy(table.rows, function (o) {
                return ringMap[o[ringIndex]].order;
            });

            let sectors = {};
            let colourGenerator = new ColourGenerator();
            table.rows.forEach(function (v, i) {
                let name = v[nameIndex];
                let description = v[descriptionIndex];
                let sectorName = v[sectorIndex];
                let ringName = v[ringIndex];
                let isNew = v[isNewIndex];

                if (!sectors[sectorName]) {
                    sectors[sectorName] = new Sector(sectorName);

                    //Check if a colour for this sector has been defined via the "Format" pane
                    //If so, set the colour, else generate a random one
                    if ("objects" in dataView.metadata
                        && sectors[sectorName].id in dataView.metadata.objects.colourSelector.$instances
                    ) {
                        sectors[sectorName].colour = dataView.metadata.objects.colourSelector.$instances[sectors[sectorName].id].fill.solid.color;
                    } else {
                        sectors[sectorName].colour = colourGenerator.getColour();
                    }
                }
                sectors[sectorName].addBlip(new Blip(name, ringMap[ringName], sectors[sectorName], isNew, description));
            });

            for (let index in sectors) {
                radar.addSector(sectors[index]);
            }

            radar.setSectorAngles();

            return radar;
        }

        /**
         * Returns the width/height of the "drawing area" of the SVG element
         */
        private getViewBoxSize() {
            return 100;
        }

        /**
         * Gets the coordinates of the center of the visual
         */
        private calculateCenter() {
            let viewBoxSize = this.getViewBoxSize();

            return {
                x: viewBoxSize / 2,
                y: viewBoxSize / 2
            };
        }

        /**
         * For if the visual is not square, as the max radius cannot be greater than the smallest side of the visual
         */
        private calculateMaxRadius() {
            let svgContainer = this.target.select("#main").node() as HTMLElement;
            let svgContainerDimensions = {
                width: svgContainer.getBoundingClientRect().width,
                height: svgContainer.getBoundingClientRect().height
            };

            return Math.min(svgContainerDimensions.width, svgContainerDimensions.height) / 2
                - (parseInt(window.getComputedStyle(svgContainer).getPropertyValue("padding")) * 2); //We need to account for the container's padding by reducing the radar's radius
        }

        /**
         * Converts coordinates relative to the radar's center into coordinates relative to the top left of the SVG container
         * @param coordinates
         */
        private convertRelativeCoordinates(coordinates: { x: number, y: number }) {
            let center = this.calculateCenter();

            return {
                x: coordinates.x + center.x,
                y: center.y - coordinates.y
            }
        };

        /**
         * Converts an angle and distance to an x,y pair. Due to the way d3 plots arcs, the angle is taken clockwise from the positive y axis rather than the standard convention
         * @param polar
         */
        private polarToCartesian(polar: { distance: number, angle: number }) {
            return {
                x: polar.distance * Math.sin(polar.angle),
                y: polar.distance * Math.cos(polar.angle)
            };
        }

        /**
         * Determines the inner and outer radii of a given ring
         * @param ring
         */
        private calculateRingRadii(ring) {
            let maxRadius = this.getViewBoxSize() / 2; //Represents the outer radius of the outer ring, i.e. half of the viewbox size. From this we can calculate other rings relatively
            let ringCount = this.radar.rings.length;

            return {
                "inner": maxRadius * (ring.order - 1) / ringCount,
                "outer": maxRadius * ring.order / ringCount
            };
        }

        /**
         * Draws all the radar's sectors onto the SVG element
         */
        private plotSectors() {
            let self = this;
            this.radar.sectors.forEach(function (sector) {
                self.plotSector(sector);
            });
        }

        /**
         * Draws a sector onto the SVG element
         * @param sector
         * @param rings
         */
        private plotSector(sector: Sector) {
            let self = this;

            let sectorGroup = this.svg.select("#sectors").append("g")
                .attr("id", "sector-" + sector.id)
                .classed("sector", true);

            this.radar.rings.forEach(function (ring) {
                let radii = self.calculateRingRadii(ring);
                let arc = d3.svg.arc()
                    .innerRadius(radii.inner)
                    .outerRadius(radii.outer)
                    .startAngle(sector.startAngle)
                    .endAngle(sector.endAngle);

                sectorGroup.append("path")
                    .attr("d", <any>arc)
                    .style("fill", ring.colour)
                    .attr("transform", "translate(" + self.calculateCenter().x + ", " + self.calculateCenter().y + ")");
            });
        }

        /**
         * Iterates over every blip on the radar and generates coordinates for it
         */
        private setBlipCoordinates() {
            let self = this;

            //We need to keep track of the coordinates of all blips so we can check whether a spot is available or not
            let allCoordinates: { x: number, y: number }[] = [];

            this.radar.sectors.forEach(function (sector) {
                sector.blips.forEach(function (blip) {
                    let coordinates = self.generateBlipCoordinates(sector, blip.ring, allCoordinates);
                    blip.coordinates = coordinates;
                    allCoordinates.push(coordinates);
                });
            });
        }

        /**
         * Given a sector and a ring to which a point belongs, randomly generates coordinates for the point
         * @param sector
         * @param ring
         */
        private generateBlipCoordinates(sector: Sector, ring: Ring, allCoordinates: { x: number, y: number }[]) {
            let min_angle = sector.startAngle + (Math.PI / 16); //The pi/16 ensures the point returned does not lay exactly on an axis where it would be covered up
            let max_angle = sector.endAngle - (Math.PI / 16);

            let ringRadii = this.calculateRingRadii(ring);
            let min_distance = ringRadii.inner * 1.1; //The multipliers ensure it cannot be plotted virtually on the ring boundaries
            let max_distance = ringRadii.outer * 0.9;
            if (min_distance === 0) {
                min_distance = max_distance / 2; //Ensure the point cannot be plotted at the very center, if it is in the central ring
            }

            let coordinates: { x: number, y: number };
            let attemptCount = 0; //Keeps track of how many times we have generated coordinates and had to discard them for being too close to another blip
            do {
                let angle = Math.random() * (max_angle - min_angle) + min_angle; //Random angle between min_angle and max_angle
                let distance = Math.random() * (max_distance - min_distance) + min_distance;

                coordinates = this.polarToCartesian({ distance: distance, angle: angle });

                attemptCount++;
                if (attemptCount >+ 10) { //If ten successive attempts fail, it is probable that there's simply nowhere to put it, so it should just be allowed to overlap another blip
                    break;
                }
            } while (!this.coordinatesAreFree(coordinates, allCoordinates));

            return coordinates;
        }

        /**
         * Determines whether the space at particular coordinates is empty or whether a blip is already plotted there
         * @param coordinates
         */
        private coordinatesAreFree(coordinates: { x: number, y: number }, allCoordinates: { x: number, y: number }[]) {
            let self = this;

            let blipRadius = this.calculateBlipRadius();

            //Go through every existing blip's coordinates, and return whether they are all a sufficient distance away or not
            return allCoordinates.every(function (currentCoordinates) {
                return self.distanceBetweenPoints(coordinates, currentCoordinates) > blipRadius * 2.1; //2.1 rather than 2 so that two blips cannot be touching each other
            });
        }

        /**
         * Calculates the distance between two points on a Cartesian plane
         * @param coordinates1
         * @param coordinates2
         */
        private distanceBetweenPoints(coordinates1: { x: number, y: number }, coordinates2: { x: number, y: number }) {
            return Math.pow(
                Math.pow(
                    coordinates1.x - coordinates2.x,
                    2
                )
                + Math.pow(
                    coordinates1.y - coordinates2.y,
                    2
                ),
                0.5
            );
        }

        /**
         * Draws all blips onto the SVG element
         */
        private plotBlips() {
            let self = this;
            this.radar.blips.forEach(function (blip) {
                self.plotBlip(blip);
            });
        }

        /**
         * Draws a blip onto the SVG element
         * @param blip
         * @param coordinates
         */
        private plotBlip(blip: Blip) {
            let self = this;
            let absoluteCoordinates = this.convertRelativeCoordinates(blip.coordinates);

            let blipGroup = this.svg.select("#blips").append("g")
                .classed("blip", true)
                .classed("blip-" + blip.id, true)
                .on("focus", function () {
                    self.collapseSidebarLists();

                    let blipTextContainer = self.svg.select("#blip-text-container");

                    blipTextContainer.append("text")
                        .attr("x", absoluteCoordinates.x)
                        .attr("y", absoluteCoordinates.y - self.calculateBlipRadius() * 2)
                        .attr("fill", "white")
                        .attr("font-size", 2.5)
                        .attr("text-anchor", "middle")
                        .text(blip.name);

                    let bBox = (blipTextContainer.node() as any).getBBox();
                    blipTextContainer.insert("rect", "#blip-text-container text") //The rectangle needs to appear before the text in the DOM, otherwise it will cover the text
                        .attr("width", bBox.width * 1.1)
                        .attr("height", bBox.height * 1.4)
                        .attr("x", bBox.x - (bBox.width * 0.05))
                        .attr("y", bBox.y - (bBox.height * 0.2))
                        .attr("rx", 2)
                        .attr("fill", blip.sector.colour);
                })
                .on("focusout", function () {
                    self.svg.select("#blip-text-container").selectAll("*").remove();
                });
            blipGroup.append("circle")
                .attr("cx", absoluteCoordinates.x)
                .attr("cy", absoluteCoordinates.y)
                .attr("r", this.calculateBlipRadius())
                .attr("fill", blip.sector.colour);
        }

        /**
         * When an item is hovered over in a sidebar list, the blip size should be increased and the list item's background changed
         * @param blip
         */
        private focusBlip(blip) {
            this.leftSidebar.select(".blip-" + blip.id)
                .style({
                    background: blip.ring.colour
                });
            this.leftSidebar.select("#blip-description")
                .html(blip.description);
            this.svg.select(".blip-" + blip.id + " circle")
                .attr("r", this.calculateBlipRadius() * 1.5);
        }

        /**
         * When a sidebar item stops being hovered over, it should return to its normal state
         * @param blip
         */
        private defocusBlip(blip) {
            this.leftSidebar.select(".blip-" + blip.id)
                .style({
                    background: "none"
                });
            this.leftSidebar.select("#blip-description").html("");
            this.svg.select(".blip-" + blip.id + " circle")
                .attr("r", this.calculateBlipRadius());
        }

        /**
         * Calculates the radius that each blip should have
         */
        private calculateBlipRadius() {
            return 2;
        }

        /**
         * Displays information about the sectors in the visual's sidebar
         * @param sectors
         */
        private plotLeftSidebar() {
            //Remove the existing sidebar
            this.leftSidebar.selectAll("*").remove();

            let self = this;

            this.radar.sectors.forEach(function (sector) {
                let mainDiv = self.leftSidebar.append("div")
                    .attr("id", "sidebar-" + sector.id);

                mainDiv.append("button")
                    .text(sector.name)
                    .style({
                        background: sector.colour
                    })
                    .on("click", function () {
                        self.collapseSidebarLists();

                        d3.select(this.parentNode).select("ul")
                            .style({
                                display: "block"
                            });
                    });

                let ul = mainDiv.append("ul")
                    .style({
                        display: "none"
                    });
                sector.blips.forEach(function (blip) {
                    ul.append("li")
                        .text(blip.name)
                        .classed("blip-" + blip.id, true)
                        .on("mouseover", function () {
                            self.focusBlip(blip);
                        })
                        .on("mouseout", function () {
                            self.defocusBlip(blip);
                        });
                });
            });

            self.leftSidebar.append("div")
                .attr("id", "blip-description");
        }

        /**
         * If there is a list visible in the sidebar, hide it
         */
        private collapseSidebarLists() {
            this.leftSidebar.selectAll("ul")
                .style({
                    display: "none"
                });
        }

        private plotRightSidebar() {
            this.rightSidebar.selectAll("*").remove();

            let self = this;
            let ul = this.rightSidebar.append("ul");

            this.radar.rings.forEach(function (ring) {
                ul.append("li")
                    .style("color", ring.colour)
                    .append("span") //Actual text is inside a span so the li's bullet can be made larger independently
                    .text(ring.name);
            });
        }

        public update(options: VisualUpdateOptions) {
            console.time("update");

            let self = this;

            this.settings = Visual.parseSettings(options && options.dataViews && options.dataViews[0]);

            this.radar = this.transformData(options.dataViews[0]);
            console.log(this.radar);

            //"Clear" the previously drawn SVG
            this.svg.selectAll("*").remove();
            
            this.svg.attr({
                width: this.calculateMaxRadius() * 2,
                height: this.calculateMaxRadius() * 2
            });

            this.svg.append("g").attr("id", "sectors");
            this.plotSectors();

            this.svg.append("g").attr("id", "blips");
            this.svg.append("g").attr("id", "blip-text-container");
            this.setBlipCoordinates();
            this.plotBlips();
            
            this.plotLeftSidebar();
            this.plotRightSidebar();

            this.updateCount++;

            console.timeEnd("update");
        }

        private static parseSettings(dataView: DataView): VisualSettings {
            return VisualSettings.parse(dataView) as VisualSettings;
        }

        /** 
         * This function gets called for each of the objects defined in the capabilities files and allows you to select which of the 
         * objects and properties you want to expose to the users in the property pane.
         * 
         */
        public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): VisualObjectInstance[] | VisualObjectInstanceEnumerationObject {
            let objectEnumeration = [];

            switch (options.objectName) {
                case "colourSelector":
                    this.radar.sectors.forEach(function (sector) {
                        objectEnumeration.push({
                            objectName: options.objectName,
                            displayName: sector.name,
                            properties: {
                                fill: {
                                    solid: {
                                        color: sector.colour
                                    }
                                }
                            },
                            selector: sector
                        });
                    });
                    break;
            }

            return objectEnumeration;
        }
    }
}