// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const uuid = require('uuid');
export const customMethodHandlers = [ 
    { 
        uid: 'populateEventIdIfNotExist', 
        match: function({ property, context }) { 
            return property === 'populateEventIdIfNotExist';
        }, 
        resolve({ params }) { 
            return `fabric-${uuid.v4()}`
        }, 
    },
    { 
        uid: 'toEscapedJson', 
        match: function({ property, context }) { 
            return property === 'toEscapedJson';
        }, 
        resolve({ params }) { 
            return JSON.stringify(params[0]) 
        }, 
    },
    {
        uid: 'retrieveItemFromRaw', 
        match: function({ property, context }) { 
            return property === 'retrieveItemFromRaw';
        }, 
        resolve({ params }) { 
            let value = '';

            try {
                // Parse the JSON string
                const parsedData = JSON.parse(params[0]);

                // Access the property if it exists
                if (parsedData && params[1] in parsedData) {
                    value = parsedData[params[1]];
                } else {
                    console.warn(`retrieveItemFromRaw: Property "${params[1]}" not found in JSON data`);
                }
            } catch (error) {
                console.error('retrieveItemFromRaw: Error parsing JSON data:', error.message);
                throw new Error(error.message);
            }
            return value
        }, 
    },
    {
        uid: 'convertTime', 
        match: function({ property, context }) { 
            return property === 'convertTime';
        }, 
        resolve({ params }) { 
            const date = new Date(params[0]);
            // Convert the date to ISO 8601 format
            const isoDatetime = date.toISOString();
            return isoDatetime;
        }, 
    }
]; 