// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0


const Velocity = require('velocityjs');
const Compile = Velocity.Compile;
const fs = require('fs');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client();
const templatesBucket = process.env.TEMPLATES_BUCKET
const defaultTemplate = process.env.DEFAULT_TEMPLATE
const cache = {}
import { customMethodHandlers } from './utils/customMethodHandlers.mjs'

//Function to get file from S3
const getFile = async (bucket, key) => {
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });

    try {
        const response = await s3.send(command);
        // The Body object also has 'transformToByteArray' and 'transformToWebStream' methods.
        const str = await response.Body.transformToString();
        console.debug(str);
        return str;
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            console.warn('S3.getObject: Key not found: ', bucket, key);
            return false
        } else {
            console.error('S3.getObject: ', err);
            throw new Error(err.message);
        }
    }
}

const getCachedFile = async (bucket, key) => {
    //Check cache
    const cacheKey = `${bucket}/${key}`
    if (cache[cacheKey] && cache[cacheKey].expiresOn > Date.now()) {
        console.debug("Cache hit: ", cacheKey);
        return cache[cacheKey].file;
    } else {
        console.debug("Cache miss:", cacheKey);
        //Get file from S3
        const file = await getFile(bucket, key);
        //Set cache. NOTE: This is storing in lambda memory, If templates get larger, may need to cache to /tmp
        cache[cacheKey] = {
            file: file,
            expiresOn: Date.now() + parseInt(process.env.CACHE_EXPIRATION_SECONDS) * 1000, // Set expiry time from env var
        }
        return file;
    } 
}

exports.handler = async (event, context, callback) => {

    try {
        console.info("App Version:", process.env.APPLICATION_VERSION)
        console.trace(`Event: `, event);

        //Get Default Template
        const vmTemplate = await getCachedFile(templatesBucket, defaultTemplate)
        const template = Velocity.parse(vmTemplate);
        let compile = new Compile(template, { 
            customMethodHandlers
        }); 

        /* Process the list of records and transform them */
        let transformedRecords = []
        for (const record of event.records) {
            const decoded = Buffer.from(record.data, 'base64');
            console.trace(`Decoded: ${decoded}`);

            let source, result, target
            //Parse Input
            try{
                source = JSON.parse(decoded);
                console.trace(`Context: ${JSON.stringify(source, null, 2)}`);
                result = 'Ok'
            }
            catch (parseError){
                console.error('json parsing error: ', parseError);
                result = 'ProcessingFailed'
            }
            
            //Apply Template
            try{
                if(result === 'Ok'){ //no sense continuing if parsing failed. 
                    const eventCode = source.metadata?.event_code
                    const productUID = source.metadata?.product?.uid
                    if (eventCode && productUID){ //checking for template override
                        const overrideTemplate = await getCachedFile(templatesBucket, `overrides/${productUID}/${eventCode.toLowerCase()}.vm`)
                        if(overrideTemplate) {
                            console.debug('Overriding default template with: ',`overrides/${productUID}/${eventCode.toLowerCase()}.vm`)
                            const orTemplate = Velocity.parse(overrideTemplate);
                            let overrideCompile = new Compile(orTemplate, { 
                                customMethodHandlers
                            }); 
                            target = overrideCompile.render(source)
                        } else {
                            target = compile.render(source)
                        }
                    } else  {
                        target = compile.render(source)
                    }
                    target = target.replace(/\s+/g, '')
                    target += '\n'
                }
                
            }
            catch (velocityError){
                console.error('velocity template error: ', velocityError);
                result = 'ProcessingFailed'
            }
            transformedRecords.push({
                recordId: record.recordId,
                result: result,
                data: Buffer.from(target).toString('base64'),
            })
        }
        console.info(`Processing completed.  Successful records ${transformedRecords.length}.`);
        console.trace(`Transformed Records: `, transformedRecords);
        return { records: transformedRecords };
    }
    catch (error) {
        console.error(error);
        callback(error)
    }
}