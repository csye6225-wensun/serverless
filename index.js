const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { Storage } = require('@google-cloud/storage');

const AdmZip = require('adm-zip');
const fs = require('fs');
const axios = require('axios');

const dotenv = require('dotenv');
dotenv.config();

const sesClient = new SESClient({ region: process.env.REGION });
const dynamoDBClient = new DynamoDBClient({ region: process.env.REGION });

exports.handler = async (event, context) => {
    try {
        const snsEvent = JSON.parse(event.Records[0].Sns.Message);
        const submission_id = snsEvent.id;
        const emailAddress = snsEvent.email;
        const Submission_url = snsEvent.submission_url;

        console.log(`Lambda function executed. id: ${submission_id}, email: ${emailAddress}, url: ${Submission_url}`);
        const accountKey = atob(process.env.ACCOUNTKEY);
        const accountKeyJson = JSON.parse(accountKey);
        let emailBody = "";
        try {
            const response = await axios.get(Submission_url, { responseType: 'arraybuffer' });
            const zipBuffer = Buffer.from(response.data);

            if (Submission_url.substr(Submission_url.length - 4) !== ".zip") {
                throw new Error('The submission file may not be a valid ZIP file.');
            }

            const zip = new AdmZip(zipBuffer);
            const zipEntries = zip.getEntries();
            if (zipEntries.length === 0) {
                throw new Error('The submission file may not be a valid ZIP file.');
            }

            const storage = new Storage({
                credentials: {
                    client_email: accountKeyJson.client_email,
                    private_key: accountKeyJson.private_key,
                },
            });

            const destinationFileName = `${submission_id}.zip`;
            await storage.bucket(process.env.BUCKETNAME).file(destinationFileName).save(zipBuffer);

            console.log(`File uploaded to ${process.env.BUCKETNAME}/${destinationFileName}`);
            emailBody = `Submission file upload successfully: ${process.env.BUCKETNAME}/${destinationFileName}`;
        } catch (error) {
            console.log('Submission file upload failed: ', error);
            emailBody = `Submission file upload failed: ${error.toString()}`;
        }

        const emailCommand = new SendEmailCommand({
            Destination: {
                CcAddresses: [],
                ToAddresses: [emailAddress],
            },
            Message: {
                Body: {
                    Text: {
                        Charset: "UTF-8",
                        Data: emailBody,
                    },
                },
                Subject: {
                    Charset: "UTF-8",
                    Data: "Assignment Submission Notification",
                },
            },
            Source: process.env.FROMADDRESS,
            ReplyToAddresses: [],
        });
        await sesClient.send(emailCommand);

        // Track sent email in DynamoDB
        const dynamoDBParams = {
            TableName: process.env.DYNAMODBNAME,
            Item: {
                id: { S: submission_id },
                email: { S: emailAddress },
                timestamp: { N: Date.now().toString() },
                status: { S: emailBody },
            },
        };
        await dynamoDBClient.send(new PutItemCommand(dynamoDBParams));

        console.log('Lambda function successful');
        return {
            statusCode: 200,
            body: JSON.stringify("Email sent and tracking completed"),
        };
    } catch (error) {
        console.error("Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify("Internal Server Error"),
        };
    }
};