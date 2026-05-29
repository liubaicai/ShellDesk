# help & tools

## 部分组件安装方案

``` shell
# mysql
podman run --name mysql-server -e MYSQL_ROOT_PASSWORD=password -d -p 3306:3306 mysql:latest
```

``` shell
# mongodb
podman run -d --name mongodb -p 27017:27017 -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=password docker.io/library/mongo:latest
```

``` shell
# postgres
podman run --name postgres-db -d -p 5432:5432 -e POSTGRES_PASSWORD=password postgres
```

``` shell
# elasticsearch
podman run -d  --name elasticsearch  -p 9200:9200 -p 9300:9300  -e "discovery.type=single-node"   -e "ES_JAVA_OPTS=-Xms1g -Xmx1g"  -v es_data:/usr/share/elasticsearch/data  docker.elastic.co/elasticsearch/elasticsearch:8.17.4
podman exec -it elasticsearch /usr/share/elasticsearch/bin/elasticsearch-reset-password -u elastic
```

``` shell
# rabbitmq
podman run -d --name my-rabbitmq -p 5672:5672 -p 15672:15672 -e RABBITMQ_DEFAULT_USER=admin -e RABBITMQ_DEFAULT_PASS=admin rabbitmq:management
```

``` shell
# vnc-server
podman run -d --name my-vnc-container -p 5900:5901 -p 6900:6901 -e VNC_PW=password docker.io/accetto/ubuntu-vnc-xfce-g3
```

``` shell
# minio
podman run -d --name minio --restart always -p 9000:9000 -p 9090:9090 -e MINIO_ROOT_USER=admin -e MINIO_ROOT_PASSWORD=password quay.io/minio/minio server /data --console-address ":9090"
wget https://dl.minio.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc
chmod +x /usr/local/bin/mc
```