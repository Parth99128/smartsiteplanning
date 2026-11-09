FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn -q package -DskipTests
FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
RUN useradd -m appuser && chown appuser app.jar
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://localhost:8080/actuator/health | grep -q '"status":"UP"'
ENTRYPOINT ["java","-jar","app.jar"]
