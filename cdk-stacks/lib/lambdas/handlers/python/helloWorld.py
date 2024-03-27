import json
import os

def handler(event, context):
    print("App Version: " + os.environ['APPLICATION_VERSION'])
    print('request: {}'.format(json.dumps(event)))
    print("environment variable: " + os.environ['MESSAGE'])
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'text/plain'
        },
        'body': os.environ['MESSAGE']
    }